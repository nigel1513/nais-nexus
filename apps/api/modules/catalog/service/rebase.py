"""rebaseDatasetVersion (spec §3.3b): re-apply a draft's changes on the latest PUBLISHED version, in place.

Shared-object protocol (object-protocol.md):
- (a/b) the draft's rows are never copied: a path taken from the latest version re-points the draft's own row
  (UPDATE, same file_id) at the latest row's object, or inserts an inherited row when the draft has none. Every
  source is a row of the latest PUBLISHED version, checked by `require_inheritable` after the version lock.
- (f) a row re-pointed or deleted loses its preview rows first (FK without cascade, the preview describes the old
  object).
- (d/e) the replaced rows' objects are released once, last; the route removes the unreferenced ones after commit.

Locks: version -> dataset (as publishDatasetVersion), then the draft's file rows. Upload creation/completion,
deleteDraftFile, discard and verification all lock the version first, so they serialize with a rebase; a publisher of
another draft of the dataset holds the dataset row, so `latest` cannot move between reading it and committing."""

from collections.abc import Mapping, Sequence
from typing import Any
from uuid import UUID

from sqlalchemy import delete, select, update
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.catalog.access import require_draft, steward_version
from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.previews.store import drop_previews
from api.modules.catalog.repo import (
    files_of_versions,
    latest_published_version,
    load_dataset,
    load_version,
    must,
)
from api.modules.catalog.schemas import RebaseIn
from api.modules.catalog.service.versions import version_response
from api.modules.catalog.tables import dataset_files, dataset_versions, upload_sessions
from api.modules.catalog.versioning.inherit import COPIED, copy_rows
from api.modules.catalog.versioning.rebase import three_way
from api.modules.catalog.versioning.refs import StorageCleanup, release_objects, require_inheritable
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode


def _by_path(rows: Sequence[RowMapping]) -> dict[str, RowMapping]:
    return {r["path"]: r for r in rows}


def _shas(rows: Mapping[str, RowMapping]) -> dict[str, str]:
    return {path: r["sha256"].strip() for path, r in rows.items()}


def _side(row: Mapping[Any, Any] | None) -> dict[str, Any] | None:
    return None if row is None else {"sha256": row["sha256"].strip(), "size_bytes": int(row["size_bytes"])}


def _unknown_paths(exc: ValueError) -> ApiError:
    paths = str(exc).removeprefix("UNKNOWN_PATH: ").split(", ")
    return ApiError(
        ErrorCode.VALIDATION_FAILED,
        "Resolutions name paths that are not in conflict.",
        {"fields": [{"field": "resolutions", "reason": "UNKNOWN_PATH", "paths": paths}]},
    )


def _has_open_upload(session: Session, version_id: UUID) -> bool:
    return (
        session.execute(
            select(upload_sessions.c.upload_session_id)
            .where(
                upload_sessions.c.dataset_version_id == version_id,
                upload_sessions.c.status == "OPEN",
                upload_sessions.c.expires_at > clock.now(),
            )
            .limit(1)
        ).first()
        is not None
    )


def rebase(
    session: Session, deps: CatalogDeps, user: CurrentUser, version_id: UUID, body: RebaseIn
) -> tuple[dict[str, Any], list[StorageCleanup]]:
    version, ds = steward_version(session, user, version_id, for_update=True)  # lock order: version first
    require_draft(version)
    # Then the dataset: no publish of another draft meanwhile.
    must(load_dataset(session, ds["dataset_id"], for_update=True), "dataset")
    latest = latest_published_version(session, ds["dataset_id"])
    latest_id: UUID | None = None if latest is None else latest["dataset_version_id"]
    # Current: a no-op, checked before the open-upload refusal (a NULL base is current only while nothing is
    # published).
    if version["base_version_id"] == latest_id:
        return version_response(session, version, sees_all_versions=True), []
    if _has_open_upload(session, version_id):
        raise ApiError(ErrorCode.CONFLICT, "Finish or cancel the open upload before updating the draft.")
    base_id: UUID | None = version["base_version_id"]
    files = files_of_versions(session, [v for v in (base_id, latest_id) if v is not None])
    mine = _by_path(
        session.execute(
            select(dataset_files).where(dataset_files.c.dataset_version_id == version_id).with_for_update()
        )
        .mappings()
        .all()
    )
    base = _by_path(files[base_id]) if base_id is not None else {}
    theirs = _by_path(files[latest_id]) if latest_id is not None else {}
    try:
        plan = three_way(_shas(base), _shas(mine), _shas(theirs), body.resolutions)
    except ValueError as exc:
        raise _unknown_paths(exc) from exc
    if plan.conflicts:
        raise ApiError(
            ErrorCode.CONFLICT,
            "Some files changed in both the draft and the latest version.",
            {
                "latest_version_id": None if latest_id is None else str(latest_id),
                "conflicts": [
                    {
                        "path": c.path,
                        "base": _side(base.get(c.path)),
                        "mine": _side(mine.get(c.path)),
                        "theirs": _side(theirs.get(c.path)),
                    }
                    for c in plan.conflicts
                ],
            },
        )
    now = clock.now()
    repoint = [(mine[p], theirs[p]) for p in plan.take_theirs if p in mine and p in theirs]
    removed = [mine[p] for p in plan.take_theirs if p in mine and p not in theirs]
    added = [theirs[p] for p in plan.take_theirs if p not in mine]
    replaced = [old for old, _ in repoint] + removed
    require_inheritable(session, [src["file_id"] for _, src in repoint], to_version_id=version_id)
    drop_previews(session, [r["file_id"] for r in replaced])  # protocol (f): before the rows change
    if removed:
        session.execute(
            delete(dataset_files).where(dataset_files.c.file_id.in_([r["file_id"] for r in removed]))
        )
    for old, src in repoint:
        session.execute(
            update(dataset_files)
            .where(dataset_files.c.file_id == old["file_id"])
            .values(
                **{c: src[c] for c in COPIED},
                upload_session_id=None,  # out of any (expired) session: expiry and verify jobs leave it alone
                inherited_from_file_id=src["file_id"],
                multipart_upload_id=None,
                part_size_bytes=None,
                status="VERIFIED",
                failure_code=None,
                updated_at=now,
            )
        )
    copy_rows(session, added, to_version_id=version_id, now=now)  # checks require_inheritable itself
    session.execute(
        update(dataset_versions)
        .where(dataset_versions.c.dataset_version_id == version_id)
        .values(base_version_id=latest_id, updated_at=now)
    )
    cleanups = release_objects(session, replaced)  # protocol (d): once, last; no locks after it
    response = version_response(
        session, must(load_version(session, version_id), "version"), sees_all_versions=True
    )
    return response, cleanups
