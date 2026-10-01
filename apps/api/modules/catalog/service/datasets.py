"""createDataset / getDataset / getDatasetPolicy (M03 §6.1, §6.3, §6.5)."""

from collections.abc import Mapping
from typing import Any
from uuid import UUID

from sqlalchemy import insert
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.catalog.access import is_steward, visible_dataset
from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.domain import InvalidPolicy, Policy, build_policy, normalize_keywords
from api.modules.catalog.repo import (
    enqueue_index,
    latest_published_version,
    load_dataset,
    must,
    readiness_overall,
)
from api.modules.catalog.schemas import DatasetCreateIn
from api.modules.catalog.tables import datasets
from api.modules.catalog.views import dataset_view, policy_view
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.events import EventActor
from api.platform.generated.error_codes import ErrorCode
from api.platform.ids import new_id
from api.platform.outbox import outbox


def policy_or_error(access_level: str, purposes: Any, max_grant_days: int | None) -> Policy:
    try:
        return build_policy(access_level, purposes, max_grant_days)
    except InvalidPolicy as exc:
        raise ApiError(ErrorCode.INVALID_POLICY, str(exc)) from exc


def insert_dataset(
    session: Session,
    *,
    dataset_id: UUID,
    owner: UUID,
    created_by: UUID,
    fields: Mapping[Any, Any],
    policy: Policy,
    actor: EventActor,
) -> None:
    now = clock.now()
    session.execute(
        insert(datasets).values(
            dataset_id=dataset_id,
            owner_organization_id=owner,
            title=fields["title"],
            description=fields.get("description") or "",
            keywords=normalize_keywords(fields.get("keywords") or []),
            domain=fields.get("domain"),
            access_level=policy.access_level,
            license=fields["license"],
            usage_policy=fields.get("usage_policy"),
            allowed_purposes=list(policy.allowed_purposes),
            approval_required=policy.approval_required,
            max_grant_days=policy.max_grant_days,
            contact_email=fields.get("contact_email"),
            provenance=fields.get("provenance"),
            status="ACTIVE",
            created_by=created_by,
            created_at=now,
            updated_at=now,
            row_version=1,
        )
    )
    outbox.write(
        session,
        "catalog.dataset.created.v1",
        {
            "dataset_id": str(dataset_id),
            "owner_organization_id": str(owner),
            "title": fields["title"],
            "access_level": policy.access_level,
        },
        actor,
    )
    enqueue_index(session, dataset_id)


def dataset_response(session: Session, deps: CatalogDeps, ds: RowMapping) -> dict[str, Any]:
    latest = latest_published_version(session, ds["dataset_id"])
    readiness = readiness_overall(session, [latest["dataset_version_id"]]) if latest else {}
    org = deps.organizations.get_organization_summary(ds["owner_organization_id"])
    return dataset_view(
        ds,
        org_name=org.name if org else None,
        latest=latest,
        latest_readiness=readiness.get(latest["dataset_version_id"]) if latest else None,
    )


def create_dataset(
    session: Session, deps: CatalogDeps, user: CurrentUser, body: DatasetCreateIn
) -> dict[str, Any]:
    owner = body.owner_organization_id
    if not is_steward(user, owner):
        raise ApiError(
            ErrorCode.FORBIDDEN, "Only a DATA_STEWARD of the owner organization can create datasets."
        )
    policy = policy_or_error(body.access_level, body.allowed_purposes, body.max_grant_days)
    org = deps.organizations.get_organization_summary(owner)
    if org is None or not deps.storage.is_configured(org.code):
        raise ApiError(
            ErrorCode.VALIDATION_FAILED,
            "The owner organization has no storage configured.",
            {"fields": [{"field": "owner_organization_id", "reason": "STORAGE_NOT_CONFIGURED"}]},
        )
    dataset_id = new_id()
    insert_dataset(
        session,
        dataset_id=dataset_id,
        owner=owner,
        created_by=user.user_id,
        fields=body.model_dump(
            exclude={"owner_organization_id", "access_level", "allowed_purposes", "max_grant_days"}
        ),
        policy=policy,
        actor=EventActor.for_user(user),
    )
    return dataset_response(session, deps, must(load_dataset(session, dataset_id), "dataset"))


def get_dataset(session: Session, deps: CatalogDeps, user: CurrentUser, dataset_id: UUID) -> dict[str, Any]:
    return dataset_response(session, deps, visible_dataset(session, user, dataset_id))


def get_policy(session: Session, user: CurrentUser, dataset_id: UUID) -> dict[str, Any]:
    return policy_view(visible_dataset(session, user, dataset_id))
