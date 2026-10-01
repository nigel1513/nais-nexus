"""updateDataset (M03 §6.4): steward only, row_version compare-and-swap, policy events, index refresh.

Existing grants are never changed here (openapi); PUBLISHED metadata_snapshot is never changed (DB trigger).
"""

from typing import Any
from uuid import UUID

from sqlalchemy import update
from sqlalchemy.orm import Session

from api.modules.catalog.access import require_steward, visible_dataset
from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.domain import Policy, normalize_keywords, normalize_purposes
from api.modules.catalog.repo import enqueue_index, load_dataset, must, rowcount
from api.modules.catalog.schemas import DatasetUpdateIn
from api.modules.catalog.service.datasets import dataset_response, policy_or_error
from api.modules.catalog.tables import datasets
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.events import EventActor
from api.platform.generated.error_codes import ErrorCode
from api.platform.outbox import outbox

POLICY_INPUTS = ("access_level", "allowed_purposes", "max_grant_days")


def update_dataset(
    session: Session, deps: CatalogDeps, user: CurrentUser, dataset_id: UUID, body: DatasetUpdateIn
) -> dict[str, Any]:
    ds = visible_dataset(session, user, dataset_id)
    require_steward(user, ds)
    changes = body.model_dump(exclude_unset=True)
    if ds["status"] == "WITHDRAWN" and changes != {"status": "ACTIVE"}:
        raise ApiError(
            ErrorCode.CONFLICT, 'A WITHDRAWN dataset can only be reactivated with {"status": "ACTIVE"}.'
        )

    previous = Policy(
        ds["access_level"],
        normalize_purposes(ds["allowed_purposes"]),
        ds["approval_required"],
        ds["max_grant_days"],
    )
    policy = policy_or_error(
        changes.get("access_level", ds["access_level"]),
        changes.get("allowed_purposes", ds["allowed_purposes"]),
        changes.get("max_grant_days", ds["max_grant_days"]),
    )
    values: dict[str, Any] = {key: value for key, value in changes.items() if key not in POLICY_INPUTS}
    if "keywords" in values:
        values["keywords"] = normalize_keywords(values["keywords"])
    values.update(
        access_level=policy.access_level,
        allowed_purposes=list(policy.allowed_purposes),
        approval_required=policy.approval_required,
        max_grant_days=policy.max_grant_days,
        updated_at=clock.now(),
        row_version=ds["row_version"] + 1,
    )
    result = session.execute(
        update(datasets)
        .where(datasets.c.dataset_id == dataset_id, datasets.c.row_version == ds["row_version"])
        .values(**values)
    )
    if rowcount(result) != 1:
        raise ApiError(ErrorCode.CONFLICT, "The dataset was modified concurrently; reload it and retry.")

    actor = EventActor.for_user(user)
    owner = str(ds["owner_organization_id"])
    if policy.access_level != previous.access_level:
        outbox.write(
            session,
            "catalog.dataset.access_level_changed.v1",
            {
                "dataset_id": str(dataset_id),
                "owner_organization_id": owner,
                "previous_access_level": previous.access_level,
                "access_level": policy.access_level,
            },
            actor,
        )
    if policy.as_event() != previous.as_event():
        outbox.write(
            session,
            "catalog.dataset.policy_changed.v1",
            {
                "dataset_id": str(dataset_id),
                "owner_organization_id": owner,
                "previous": previous.as_event(),
                "current": policy.as_event(),
            },
            actor,
        )
    enqueue_index(session, dataset_id)
    return dataset_response(session, deps, must(load_dataset(session, dataset_id), "dataset"))
