"""Dataset versions (M03 §5.1, §6.6; spec §3.3b): DRAFT creation (zero-copy branch / revert / empty), listing,
detail with the file manifest, change-note update and discard."""

from collections.abc import Mapping
from typing import Any
from uuid import UUID

from sqlalchemy import delete, insert, select, update
from sqlalchemy.engine import RowMapping
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.modules.catalog.access import (
    can_see_all_versions,
    can_see_version,
    not_found,
    require_draft,
    require_steward,
    steward_version,
    visible_dataset,
)
from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.previews.store import drop_previews
from api.modules.catalog.repo import (
    files_of_versions,
    latest_published_version,
    load_dataset,
    load_version,
    must,
    readiness_overall,
)
from api.modules.catalog.schemas import VersionCreateIn, VersionUpdateIn
from api.modules.catalog.service.diff import summaries
from api.modules.catalog.tables import dataset_files, dataset_versions, file_previews, upload_sessions
from api.modules.catalog.versioning.inherit import copy_files
from api.modules.catalog.versioning.refs import StorageCleanup, release_objects
from api.modules.catalog.views import version_view
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.ids import new_id


def _label_exists() -> ApiError:
    return ApiError(
        ErrorCode.DATASET_VERSION_LABEL_EXISTS, "This version label is already used in the dataset."
    )


def _latest_id(session: Session, dataset_id: UUID) -> UUID | None:
    latest = latest_published_version(session, dataset_id)
    return None if latest is None else latest["dataset_version_id"]


def _base_is_latest(version: Mapping[Any, Any], latest_id: UUID | None) -> bool | None:
    """DRAFT only: publishable without rebase when its base is still the latest PUBLISHED version (a first draft
    has no base and nothing published: also current)."""
    if version["status"] != "DRAFT":
        return None
    return bool(version["base_version_id"] == latest_id)


def version_response(session: Session, version: RowMapping) -> dict[str, Any]:
    version_id = version["dataset_version_id"]
    files = files_of_versions(session, [version_id])[version_id]
    readiness = (
        readiness_overall(session, [version_id])[version_id] if version["status"] == "PUBLISHED" else None
    )
    latest_id = _latest_id(session, version["dataset_id"]) if version["status"] == "DRAFT" else None
    return version_view(
        version,
        files,
        readiness,
        base_is_latest=_base_is_latest(version, latest_id),
        change_summary=summaries(session, [version])[version_id],
    )


def _not_published_source() -> ApiError:
    return ApiError(
        ErrorCode.VALIDATION_FAILED,
        "from_version_id must be a PUBLISHED version of this dataset.",
        {"fields": [{"field": "from_version_id", "reason": "VERSION_NOT_PUBLISHED"}]},
    )


def create_version(
    session: Session, user: CurrentUser, dataset_id: UUID, body: VersionCreateIn
) -> dict[str, Any]:
    ds = visible_dataset(session, user, dataset_id, for_update=True)
    require_steward(user, ds)
    if ds["status"] != "ACTIVE":
        raise ApiError(ErrorCode.CONFLICT, "WITHDRAWN datasets cannot get new versions.")
    duplicate = session.execute(
        select(dataset_versions.c.dataset_version_id).where(
            dataset_versions.c.dataset_id == dataset_id,
            dataset_versions.c.version_label == body.version_label,
        )
    ).first()
    if duplicate is not None:
        raise _label_exists()
    if body.empty and body.from_version_id is not None:
        raise ApiError(
            ErrorCode.VALIDATION_FAILED,
            "Choose either empty or from_version_id.",
            {"fields": [{"field": "empty", "reason": "MUTUALLY_EXCLUSIVE"}]},
        )
    # The dataset row lock (above) serializes against publish of this dataset: `latest` cannot change under us.
    latest_id = _latest_id(session, dataset_id)
    if body.from_version_id is not None:
        src = load_version(session, body.from_version_id)
        if src is None or src["dataset_id"] != dataset_id or src["status"] != "PUBLISHED":
            raise _not_published_source()
    source_id = None if body.empty else (body.from_version_id or latest_id)
    version_id = new_id()
    now = clock.now()
    try:
        with session.begin_nested():
            session.execute(
                insert(dataset_versions).values(
                    dataset_version_id=version_id,
                    dataset_id=dataset_id,
                    version_label=body.version_label,
                    status="DRAFT",
                    change_note=body.change_note,
                    created_by=user.user_id,
                    base_version_id=latest_id,
                    source_version_id=source_id,
                    created_at=now,
                    updated_at=now,
                )
            )
    except IntegrityError as exc:
        raise _label_exists() from exc
    if source_id is not None:
        copy_files(session, from_version_id=source_id, to_version_id=version_id, now=now)
    return version_response(session, must(load_version(session, version_id), "version"))


def list_versions(session: Session, user: CurrentUser, dataset_id: UUID) -> dict[str, Any]:
    ds = visible_dataset(session, user, dataset_id)
    stmt = select(dataset_versions).where(dataset_versions.c.dataset_id == dataset_id)
    if not can_see_all_versions(user, ds["owner_organization_id"]):
        stmt = stmt.where(dataset_versions.c.status == "PUBLISHED")
    versions = (
        session.execute(
            stmt.order_by(dataset_versions.c.created_at.desc(), dataset_versions.c.dataset_version_id.desc())
        )
        .mappings()
        .all()
    )
    ids = [v["dataset_version_id"] for v in versions]
    files = files_of_versions(session, ids)
    readiness = readiness_overall(
        session, [v["dataset_version_id"] for v in versions if v["status"] == "PUBLISHED"]
    )
    # base_is_latest is a DRAFT-only field: skip the query when the caller sees no drafts.
    latest_id = _latest_id(session, dataset_id) if any(v["status"] == "DRAFT" for v in versions) else None
    changes = summaries(session, versions)
    return {
        "items": [
            version_view(
                v,
                files[v["dataset_version_id"]],
                readiness.get(v["dataset_version_id"]),
                base_is_latest=_base_is_latest(v, latest_id),
                change_summary=changes[v["dataset_version_id"]],
            )
            for v in versions
        ]
    }


def get_version(session: Session, user: CurrentUser, version_id: UUID) -> dict[str, Any]:
    version = load_version(session, version_id)
    if version is None:
        raise not_found("Dataset version")
    ds = must(load_dataset(session, version["dataset_id"]), "dataset")
    if not can_see_version(user, ds, version):
        raise not_found("Dataset version")
    return version_response(session, version)


def update_version(
    session: Session, user: CurrentUser, version_id: UUID, body: VersionUpdateIn
) -> dict[str, Any]:
    version, _ = steward_version(session, user, version_id, for_update=True)
    require_draft(version)
    session.execute(
        update(dataset_versions)
        .where(dataset_versions.c.dataset_version_id == version_id)
        .values(change_note=body.change_note, updated_at=clock.now())
    )
    return version_response(session, must(load_version(session, version_id), "version"))


def discard_version(
    session: Session, deps: CatalogDeps, user: CurrentUser, version_id: UUID
) -> list[StorageCleanup]:
    """Shared-object protocol (c). Lock order version -> upload sessions -> files (as completeUploadSession);
    preview rows go before file rows (FK, no cascade); objects are released once, last, and removed by the route
    after commit only when no other row references them (spec §3.3b)."""
    version, _ = steward_version(session, user, version_id, for_update=True)
    require_draft(version)
    session.execute(
        select(upload_sessions.c.upload_session_id)
        .where(upload_sessions.c.dataset_version_id == version_id)
        .with_for_update()
    )
    files = (
        session.execute(
            select(dataset_files).where(dataset_files.c.dataset_version_id == version_id).with_for_update()
        )
        .mappings()
        .all()
    )
    drop_previews(session, [f["file_id"] for f in files])
    session.execute(delete(file_previews).where(file_previews.c.dataset_version_id == version_id))
    session.execute(delete(dataset_files).where(dataset_files.c.dataset_version_id == version_id))
    session.execute(delete(upload_sessions).where(upload_sessions.c.dataset_version_id == version_id))
    session.execute(delete(dataset_versions).where(dataset_versions.c.dataset_version_id == version_id))
    return release_objects(session, list(files))
