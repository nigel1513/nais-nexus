"""completeUploadSession and deleteDraftFile (M03 §5.2, §6.6, D-014)."""

import logging
from collections.abc import Sequence
from typing import Any
from uuid import UUID

from sqlalchemy import delete, select, update
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.catalog.access import can_see_dataset, is_steward, not_found, require_draft, steward_version
from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.errors import dependency_errors
from api.modules.catalog.objects import MultipartFailed, ObjectStore
from api.modules.catalog.repo import load_dataset, load_version, must, rowcount
from api.modules.catalog.schemas import UploadCompleteIn
from api.modules.catalog.service.uploads import (
    StorageCleanup,
    abort_quietly,
    cleanup_target,
    upload_session_response,
)
from api.modules.catalog.tables import dataset_files, upload_sessions
from api.modules.catalog.verification import verify_in_session
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode

logger = logging.getLogger("nais.catalog.completion")


def _parts_by_file(files: Sequence[RowMapping], body: UploadCompleteIn) -> dict[UUID, list[tuple[int, str]]]:
    multipart_ids = {f["file_id"] for f in files if f["multipart_upload_id"]}
    given = {item.file_id: [(e.part_number, e.etag) for e in item.etags] for item in body.parts}
    problems = [
        {"field": "parts", "reason": "UNKNOWN_FILE", "file_id": str(file_id)}
        for file_id in given
        if file_id not in multipart_ids
    ]
    problems += [
        {"field": "parts", "reason": "MISSING_PARTS", "file_id": str(file_id)}
        for file_id in sorted(multipart_ids, key=str)
        if not given.get(file_id)
    ]
    if problems:
        raise ApiError(
            ErrorCode.VALIDATION_FAILED, "Multipart files need their part ETags.", {"fields": problems}
        )
    return given


def _finalize_upload(
    store: ObjectStore, f: RowMapping, parts: list[tuple[int, str]] | None
) -> tuple[str, str | None]:
    key = f["storage_key"]
    if f["multipart_upload_id"]:
        try:
            store.complete_multipart(key, f["multipart_upload_id"], parts or [])
        except MultipartFailed:
            # A retry after a mid-loop 503 finds the upload already completed in storage: if the object exists,
            # carry on to the size/verification path instead of failing a good file.
            if store.head(key) is None:
                abort_quietly(store, key, f["multipart_upload_id"])
                return "FAILED", "OBJECT_MISSING"
    size = store.head(key)
    if size is None:
        return "FAILED", "OBJECT_MISSING"
    if size != int(f["size_bytes"]):
        store.delete(key)
        return "FAILED", "SIZE_MISMATCH"
    return "UPLOADED", None


def complete_upload_session(
    session: Session, deps: CatalogDeps, user: CurrentUser, upload_session_id: UUID, body: UploadCompleteIn
) -> tuple[dict[str, Any], list[UUID]]:
    probe = session.execute(
        select(upload_sessions.c.dataset_version_id).where(
            upload_sessions.c.upload_session_id == upload_session_id
        )
    ).first()
    if probe is None:
        raise not_found("Upload session")
    # Lock order: version -> session -> files (create_upload_session locks the version first).
    version = load_version(session, probe[0], for_update=True)
    if version is None:
        raise not_found("Upload session")
    sess = (
        session.execute(
            select(upload_sessions)
            .where(upload_sessions.c.upload_session_id == upload_session_id)
            .with_for_update()
        )
        .mappings()
        .first()
    )
    if sess is None:
        raise not_found("Upload session")
    ds = must(load_dataset(session, version["dataset_id"]), "dataset")
    if sess["created_by"] != user.user_id and not is_steward(user, ds["owner_organization_id"]):
        if can_see_dataset(user, ds):
            raise ApiError(
                ErrorCode.FORBIDDEN,
                "Only the session creator or an owner-organization steward can complete it.",
            )
        raise not_found("Upload session")
    require_draft(version)
    now = clock.now()
    if sess["status"] == "EXPIRED" or (sess["status"] == "OPEN" and sess["expires_at"] <= now):
        raise ApiError(ErrorCode.UPLOAD_SESSION_EXPIRED, "Upload session expired; create a new one.")
    if sess["status"] != "OPEN":
        raise ApiError(ErrorCode.CONFLICT, "Upload session is already completed.")
    files = (
        session.execute(
            select(dataset_files)
            .where(
                dataset_files.c.upload_session_id == upload_session_id, dataset_files.c.status == "PENDING"
            )
            .order_by(dataset_files.c.path.collate("C"))
            .with_for_update()
        )
        .mappings()
        .all()
    )
    parts = _parts_by_file(files, body)
    uploaded: list[RowMapping] = []
    with dependency_errors():
        for f in files:
            store = deps.storage.for_bucket(f["storage_bucket"])
            status, failure = _finalize_upload(store, f, parts.get(f["file_id"]))
            result = session.execute(
                update(dataset_files)
                .where(
                    dataset_files.c.file_id == f["file_id"],
                    dataset_files.c.status == "PENDING",
                    dataset_files.c.upload_session_id == upload_session_id,
                )
                .values(status=status, failure_code=failure, updated_at=now)
            )
            if rowcount(result) == 1 and status == "UPLOADED":
                uploaded.append(f)
        session.execute(
            update(upload_sessions)
            .where(upload_sessions.c.upload_session_id == upload_session_id)
            .values(status="COMPLETED", completed_at=now)
        )
        to_verify: list[UUID] = []
        if sum(int(f["size_bytes"]) for f in uploaded) <= deps.settings.catalog_sync_verify_max_bytes:
            for f in uploaded:
                try:
                    with session.begin_nested():
                        verify_in_session(session, deps, f)
                except (
                    Exception
                ):  # storage/scanner trouble: leave the file UPLOADED for the worker, never stuck
                    logger.warning(
                        "sync verification failed; deferring to worker",
                        extra={"file_id": str(f["file_id"])},
                        exc_info=True,
                    )
                    to_verify.append(f["file_id"])
        else:
            to_verify = [f["file_id"] for f in uploaded]
        return upload_session_response(session, deps, upload_session_id), to_verify


def delete_draft_file(
    session: Session, deps: CatalogDeps, user: CurrentUser, version_id: UUID, file_id: UUID
) -> StorageCleanup:
    """Returns the object to remove; the route deletes it after the transaction committed."""
    version, _ = steward_version(session, user, version_id, for_update=True)
    require_draft(version)
    f = (
        session.execute(
            select(dataset_files).where(
                dataset_files.c.file_id == file_id, dataset_files.c.dataset_version_id == version_id
            )
        )
        .mappings()
        .first()
    )
    if f is None:
        raise not_found("File")
    if f["status"] == "PENDING":
        sess = (
            session.execute(
                select(upload_sessions).where(upload_sessions.c.upload_session_id == f["upload_session_id"])
            )
            .mappings()
            .first()
        )
        if sess is not None and sess["status"] == "OPEN" and sess["expires_at"] > clock.now():
            raise ApiError(ErrorCode.CONFLICT, "The file is still being uploaded in an open session.")
    session.execute(delete(dataset_files).where(dataset_files.c.file_id == file_id))
    return cleanup_target(f)
