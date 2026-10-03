"""Pinned dataset inputs (spec §5.2). Events go to the outbox in the request's transaction."""

import logging
from collections.abc import Sequence
from typing import Any
from uuid import UUID

from sqlalchemy.engine import RowMapping
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.modules.catalog.public import CatalogQueryPort, DatasetPolicyView, VersionView
from api.modules.workspace import repo
from api.modules.workspace.access import has_dataset_access, require_reader, require_writer
from api.modules.workspace.deps import WorkspaceDeps
from api.modules.workspace.errors import access_required, not_found
from api.modules.workspace.schemas import InputCreateIn, InputUpdateIn, ProjectInput
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.events import EventActor
from api.platform.generated.error_codes import ErrorCode
from api.platform.generated.event_types import EventType
from api.platform.ids import new_id
from api.platform.outbox import outbox

logger = logging.getLogger("nais.workspace")


# ---------------------------------------------------------------- reads


def list_inputs(
    session: Session, deps: WorkspaceDeps, user: CurrentUser, project_id: UUID
) -> list[ProjectInput]:
    require_reader(deps, project_id, user)
    return _views(deps, user, repo.live_inputs(session, project_id))


def _views(deps: WorkspaceDeps, user: CurrentUser, rows: Sequence[RowMapping]) -> list[ProjectInput]:
    """access_lapsed is evaluated for the caller; newer_version_label against the latest PUBLISHED version."""
    if not rows:
        return []
    catalog = deps.catalog
    names = deps.people.get_display_names([r["added_by"] for r in rows])
    policies: dict[UUID, DatasetPolicyView | None] = {}
    latest: dict[UUID, VersionView | None] = {}
    views: list[ProjectInput] = []
    for row in rows:
        dataset_id = row["dataset_id"]
        if dataset_id not in policies:
            policies[dataset_id] = catalog.get_policy_view(dataset_id)
            latest[dataset_id] = catalog.get_latest_published_version(dataset_id)
        policy = policies[dataset_id]
        pinned = catalog.get_version(row["dataset_version_id"])
        if policy is None or pinned is None:  # catalog never deletes datasets or published versions
            logger.error(
                "pinned input references a missing dataset/version", extra={"input_id": row["input_id"]}
            )
            continue
        newest = latest[dataset_id]
        views.append(
            _view(
                row,
                policy,
                pinned,
                newer=newest if newest and newest.dataset_version_id != pinned.dataset_version_id else None,
                lapsed=not has_dataset_access(deps, user, policy),
                added_by_name=names.get(row["added_by"], ""),
            )
        )
    return views


def _view(
    row: RowMapping,
    policy: DatasetPolicyView,
    pinned: VersionView,
    *,
    newer: VersionView | None,
    lapsed: bool,
    added_by_name: str,
) -> ProjectInput:
    return ProjectInput.model_validate(
        {
            "input_id": row["input_id"],
            "project_id": row["project_id"],
            "dataset_id": row["dataset_id"],
            "dataset_title": policy.title,
            "dataset_version_id": row["dataset_version_id"],
            "version_label": pinned.version_label,
            "newer_version_label": newer.version_label if newer else None,
            "access_level": policy.access_level,
            "access_lapsed": lapsed,
            "added_by": row["added_by"],
            "added_by_display_name": added_by_name,
            "added_at": row["added_at"],
            "note": row["note"],
        }
    )


def _single_view(deps: WorkspaceDeps, user: CurrentUser, row: RowMapping) -> ProjectInput:
    [view] = _views(deps, user, [row])
    return view


# ---------------------------------------------------------------- catalog checks


def _usable_dataset(deps: WorkspaceDeps, user: CurrentUser, dataset_id: UUID) -> DatasetPolicyView:
    """Visible (else 404) and ACTIVE (else 409) dataset; access is checked after the version."""
    catalog = deps.catalog
    policy = catalog.get_policy_view(dataset_id) if catalog.is_visible(user, dataset_id) else None
    if policy is None:
        raise not_found("Dataset")
    if policy.status != "ACTIVE":
        raise ApiError(ErrorCode.CONFLICT, "The dataset is withdrawn.")
    return policy


def _published_version(catalog: CatalogQueryPort, dataset_id: UUID, version_id: UUID | None) -> VersionView:
    if version_id is None:
        latest = catalog.get_latest_published_version(dataset_id)
        if latest is None:
            raise ApiError(ErrorCode.DATASET_VERSION_NOT_PUBLISHED, "The dataset has no published version.")
        return latest
    version = catalog.get_version(version_id)
    if version is None:
        raise not_found("Dataset version")
    if version.dataset_id != dataset_id:
        raise ApiError(
            ErrorCode.VALIDATION_FAILED,
            "dataset_version_id does not belong to the dataset.",
            {"field": "dataset_version_id"},
        )
    if version.status != "PUBLISHED":
        raise ApiError(ErrorCode.DATASET_VERSION_NOT_PUBLISHED, "Only a PUBLISHED version can be pinned.")
    return version


def _require_access(deps: WorkspaceDeps, user: CurrentUser, policy: DatasetPolicyView) -> None:
    if not has_dataset_access(deps, user, policy):
        raise access_required(policy.dataset_id)


# ---------------------------------------------------------------- writes


def add_input(
    session: Session, deps: WorkspaceDeps, user: CurrentUser, project_id: UUID, body: InputCreateIn
) -> ProjectInput:
    require_writer(deps, project_id, user)
    policy = _usable_dataset(deps, user, body.dataset_id)
    version = _published_version(deps.catalog, body.dataset_id, body.dataset_version_id)
    _require_access(deps, user, policy)
    if repo.live_input_for_dataset(session, project_id, body.dataset_id) is not None:
        raise _duplicate()
    try:
        with session.begin_nested():
            row = repo.insert_input(
                session,
                input_id=new_id(),
                project_id=project_id,
                dataset_id=body.dataset_id,
                dataset_version_id=version.dataset_version_id,
                added_by=user.user_id,
                added_at=clock.now(),
                note=body.note,
            )
    except IntegrityError as exc:  # concurrent add of the same dataset (uq_inputs_live_dataset)
        raise _duplicate() from exc
    outbox.write(
        session,
        EventType.WORKSPACE_INPUT_ADDED_V1,
        _payload(row, user, policy, version),
        EventActor.for_user(user),
    )
    return _single_view(deps, user, row)


def update_input(
    session: Session,
    deps: WorkspaceDeps,
    user: CurrentUser,
    project_id: UUID,
    input_id: UUID,
    body: InputUpdateIn,
) -> ProjectInput:
    require_writer(deps, project_id, user)
    row = repo.load_live_input(session, project_id, input_id, for_update=True)
    if row is None:
        raise not_found("Input")
    values: dict[str, Any] = {}
    if "note" in body.model_fields_set:
        values["note"] = body.note
    new_version_id = body.dataset_version_id
    if new_version_id is not None and new_version_id != row["dataset_version_id"]:
        # an explicit, audited change that re-checks access like addProjectInput
        policy = _usable_dataset(deps, user, row["dataset_id"])
        version = _published_version(deps.catalog, row["dataset_id"], new_version_id)
        _require_access(deps, user, policy)
        previous = deps.catalog.get_version(row["dataset_version_id"])
        values["dataset_version_id"] = version.dataset_version_id
        updated = repo.update_input(session, input_id, **values)
        outbox.write(
            session,
            EventType.WORKSPACE_INPUT_VERSION_CHANGED_V1,
            _payload(updated, user, policy, version)
            | {
                "previous_dataset_version_id": str(row["dataset_version_id"]),
                "previous_version_label": previous.version_label if previous else "",
            },
            EventActor.for_user(user),
        )
        return _single_view(deps, user, updated)
    if values:
        row = repo.update_input(session, input_id, **values)
    return _single_view(deps, user, row)


def remove_input(
    session: Session, deps: WorkspaceDeps, user: CurrentUser, project_id: UUID, input_id: UUID
) -> None:
    require_writer(deps, project_id, user)
    row = repo.load_live_input(session, project_id, input_id, for_update=True)
    if row is None:
        raise not_found("Input")
    removed = repo.update_input(session, input_id, removed_at=clock.now())
    catalog = deps.catalog
    policy = catalog.get_policy_view(row["dataset_id"])
    version = catalog.get_version(row["dataset_version_id"])
    if policy is None or version is None:  # catalog never deletes datasets or published versions
        raise not_found("Dataset version")
    outbox.write(
        session,
        EventType.WORKSPACE_INPUT_REMOVED_V1,
        _payload(removed, user, policy, version),
        EventActor.for_user(user),
    )


def _duplicate() -> ApiError:
    return ApiError(ErrorCode.CONFLICT, "The dataset is already an input of this project.")


def _payload(
    row: RowMapping, user: CurrentUser, policy: DatasetPolicyView, version: VersionView
) -> dict[str, Any]:
    return {
        "project_id": str(row["project_id"]),
        "actor_id": str(user.user_id),
        "occurred_at": clock.now().isoformat(),
        "input_id": str(row["input_id"]),
        "dataset_id": str(row["dataset_id"]),
        "dataset_title": policy.title,
        "dataset_version_id": str(version.dataset_version_id),
        "version_label": version.version_label,
        "owner_organization_id": str(policy.owner_organization_id),
    }
