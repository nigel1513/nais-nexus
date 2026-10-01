"""Upload sessions (M03 §5.2, §5.3, §6.6): validation, presigned PUT / multipart instructions."""

import logging
from collections.abc import Mapping, Sequence
from datetime import timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import func, insert, select, update
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.catalog.access import is_steward, not_found, require_draft, steward_version
from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.domain import (
    MAX_FILE_BYTES,
    MAX_FILES_PER_VERSION,
    MAX_PARTS,
    canonical_media_type,
    checksum_b64,
    media_type_allowed,
    part_count,
    path_problem,
    storage_key,
)
from api.modules.catalog.errors import dependency_errors
from api.modules.catalog.objects import MultipartFailed, ObjectStore, StorageUnavailable
from api.modules.catalog.repo import load_dataset, load_version, must
from api.modules.catalog.schemas import UploadFileIn, UploadSessionCreateIn
from api.modules.catalog.settings import CatalogSettings
from api.modules.catalog.tables import dataset_files, upload_sessions
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.ids import new_id
from api.platform.storage import StorageNotConfigured

logger = logging.getLogger("nais.catalog.uploads")


def org_store(deps: CatalogDeps, ds: Mapping[Any, Any]) -> ObjectStore:
    org = deps.organizations.get_organization_summary(ds["owner_organization_id"])
    if org is None:
        raise StorageNotConfigured(f"unknown organization {ds['owner_organization_id']}")
    return deps.storage.for_org(org.code)


def abort_quietly(store: ObjectStore, key: str, upload_id: str) -> None:
    try:
        store.abort_multipart(key, upload_id)
    except (StorageUnavailable, MultipartFailed):
        logger.warning("could not abort multipart upload", extra={"storage_key": key}, exc_info=True)


def _validate_files(files: Sequence[UploadFileIn], settings: CatalogSettings) -> None:
    fields: list[dict[str, str]] = []
    seen: set[str] = set()
    for index, spec in enumerate(files):
        problem = path_problem(spec.path)
        if problem is None and spec.path in seen:
            problem = "DUPLICATE_PATH"
        if problem is not None:
            fields.append({"field": f"files.{index}.path", "reason": problem})
        seen.add(spec.path)
    if fields:
        raise ApiError(ErrorCode.VALIDATION_FAILED, "Invalid file path.", {"fields": fields})
    bad_types = [
        {"path": spec.path, "media_type": spec.media_type}
        for spec in files
        if not media_type_allowed(spec.path, spec.media_type)
    ]
    if bad_types:
        raise ApiError(
            ErrorCode.FILE_TYPE_NOT_ALLOWED, "File type is not in the allow list.", {"files": bad_types}
        )
    too_large = [
        {"path": spec.path, "size_bytes": spec.size_bytes}
        for spec in files
        if spec.size_bytes > MAX_FILE_BYTES
        or part_count(spec.size_bytes, settings.catalog_multipart_part_size_bytes) > MAX_PARTS
    ]
    if too_large:
        raise ApiError(
            ErrorCode.FILE_TOO_LARGE,
            "File exceeds the per-file limit.",
            {"files": too_large, "max_bytes": MAX_FILE_BYTES},
        )


def upload_instructions(store: ObjectStore, f: Mapping[Any, Any], ttl: int) -> dict[str, Any]:
    if f["multipart_upload_id"]:
        part_size = int(f["part_size_bytes"])
        return {
            "method": "MULTIPART",
            "part_size_bytes": part_size,
            "parts": [
                {
                    "part_number": n,
                    "url": store.presign_part(f["storage_key"], f["multipart_upload_id"], n, ttl),
                }
                for n in range(1, part_count(int(f["size_bytes"]), part_size) + 1)
            ],
        }
    url, headers = store.presign_put(
        f["storage_key"], f["media_type"], checksum_b64(f["sha256"].strip()), ttl
    )
    return {"method": "PUT", "url": url, "headers": headers}


def upload_session_response(session: Session, deps: CatalogDeps, upload_session_id: UUID) -> dict[str, Any]:
    sess = must(
        session.execute(
            select(upload_sessions).where(upload_sessions.c.upload_session_id == upload_session_id)
        )
        .mappings()
        .first(),
        "upload session",
    )
    files = (
        session.execute(
            select(dataset_files)
            .where(dataset_files.c.upload_session_id == upload_session_id)
            .order_by(dataset_files.c.path.collate("C"))
        )
        .mappings()
        .all()
    )
    is_open = sess["status"] == "OPEN" and sess["expires_at"] > clock.now()
    items: list[dict[str, Any]] = []
    for f in files:
        item: dict[str, Any] = {
            "file_id": f["file_id"],
            "path": f["path"],
            "status": f["status"],
            "failure_code": f["failure_code"],
        }
        if is_open and f["status"] == "PENDING":
            store = deps.storage.for_bucket(f["storage_bucket"])
            item["upload"] = upload_instructions(store, f, deps.settings.upload_url_ttl_seconds)
        items.append(item)
    return {
        "upload_session_id": sess["upload_session_id"],
        "dataset_version_id": sess["dataset_version_id"],
        "status": sess["status"],
        "expires_at": sess["expires_at"],
        "files": items,
    }


def _existing_rows(session: Session, version_id: UUID, paths: Sequence[str]) -> dict[str, RowMapping]:
    stmt = (
        select(
            dataset_files,
            upload_sessions.c.status.label("session_status"),
            upload_sessions.c.expires_at.label("session_expires_at"),
        )
        .select_from(
            dataset_files.join(
                upload_sessions, dataset_files.c.upload_session_id == upload_sessions.c.upload_session_id
            )
        )
        .where(dataset_files.c.dataset_version_id == version_id, dataset_files.c.path.in_(list(paths)))
    )
    return {row["path"]: row for row in session.execute(stmt).mappings()}


def create_upload_session(
    session: Session, deps: CatalogDeps, user: CurrentUser, version_id: UUID, body: UploadSessionCreateIn
) -> dict[str, Any]:
    version, ds = steward_version(session, user, version_id, for_update=True)
    require_draft(version)
    settings = deps.settings
    _validate_files(body.files, settings)
    now = clock.now()
    paths = [spec.path for spec in body.files]
    existing = _existing_rows(session, version_id, paths)
    conflicts = sorted(
        path
        for path, row in existing.items()
        if row["status"] in ("UPLOADED", "VERIFIED")
        or (
            row["status"] == "PENDING" and row["session_status"] == "OPEN" and row["session_expires_at"] > now
        )
    )
    if conflicts:
        raise ApiError(ErrorCode.CONFLICT, "These paths already exist in the version.", {"paths": conflicts})
    others = session.execute(
        select(func.count())
        .select_from(dataset_files)
        .where(dataset_files.c.dataset_version_id == version_id, dataset_files.c.path.not_in(paths))
    ).scalar_one()
    if int(others) + len(paths) > MAX_FILES_PER_VERSION:
        raise ApiError(
            ErrorCode.VALIDATION_FAILED,
            f"A version holds at most {MAX_FILES_PER_VERSION} files.",
            {"fields": [{"field": "files", "reason": "TOO_MANY_FILES"}]},
        )
    with dependency_errors():
        store = org_store(deps, ds)
        upload_session_id = new_id()
        session.execute(
            insert(upload_sessions).values(
                upload_session_id=upload_session_id,
                dataset_version_id=version_id,
                status="OPEN",
                created_by=user.user_id,
                expires_at=now + timedelta(seconds=settings.upload_session_ttl_seconds),
                created_at=now,
            )
        )
        for spec in body.files:
            key = storage_key(ds["dataset_id"], version_id, spec.path)
            media_type = canonical_media_type(spec.media_type)
            multipart = spec.size_bytes > settings.storage_multipart_threshold_bytes
            values: dict[str, Any] = {
                "upload_session_id": upload_session_id,
                "size_bytes": spec.size_bytes,
                "sha256": spec.sha256,
                "media_type": media_type,
                "storage_bucket": store.bucket,
                "storage_key": key,
                "multipart_upload_id": store.create_multipart(key, media_type) if multipart else None,
                "part_size_bytes": settings.catalog_multipart_part_size_bytes if multipart else None,
                "status": "PENDING",
                "failure_code": None,
                "scan_status": "SKIPPED",
                "verified_at": None,
                "updated_at": now,
            }
            old = existing.get(spec.path)
            if old is None:
                session.execute(
                    insert(dataset_files).values(
                        file_id=new_id(),
                        dataset_version_id=version_id,
                        path=spec.path,
                        created_at=now,
                        **values,
                    )
                )
                continue
            if old["status"] == "PENDING" and old["multipart_upload_id"]:
                abort_quietly(store, old["storage_key"], old["multipart_upload_id"])
            session.execute(
                update(dataset_files).where(dataset_files.c.file_id == old["file_id"]).values(**values)
            )
        return upload_session_response(session, deps, upload_session_id)


def get_upload_session(
    session: Session, deps: CatalogDeps, user: CurrentUser, upload_session_id: UUID
) -> dict[str, Any]:
    sess = (
        session.execute(
            select(upload_sessions).where(upload_sessions.c.upload_session_id == upload_session_id)
        )
        .mappings()
        .first()
    )
    if sess is None:
        raise not_found("Upload session")
    version = must(load_version(session, sess["dataset_version_id"]), "version")
    ds = must(load_dataset(session, version["dataset_id"]), "dataset")
    if not is_steward(user, ds["owner_organization_id"]):
        raise not_found("Upload session")
    with dependency_errors():
        return upload_session_response(session, deps, upload_session_id)
