"""getFileProfile / getFilePreview (Wave 1.5 spec §7 열람 범위 규칙, D-018).

Profile = metadata (no raw values): everyone who can see the version. Preview = raw values: download permission
only (PLATFORM_ADMIN, current owner-organization member, PUBLIC dataset, ACTIVE grant via PreviewGrantLookup);
otherwise 403 with details.reason DOWNLOAD_PERMISSION_REQUIRED. An invisible file is 404 either way."""

from collections.abc import Mapping
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.catalog.access import can_see_version, not_found
from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.previews.profile import table_format
from api.modules.catalog.repo import load_dataset, load_version, must
from api.modules.catalog.service.diff import MAX_INHERIT_HOPS
from api.modules.catalog.tables import dataset_files, file_previews
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode


def _load(
    session: Session, user: CurrentUser, file_id: UUID
) -> tuple[RowMapping, RowMapping, RowMapping | None]:
    f = session.execute(select(dataset_files).where(dataset_files.c.file_id == file_id)).mappings().first()
    if f is None:
        raise not_found("File")
    version = must(load_version(session, f["dataset_version_id"]), "version")
    ds = must(load_dataset(session, version["dataset_id"]), "dataset")
    if not can_see_version(user, ds, version):
        raise not_found("File")
    return f, ds, _preview_row(session, f)


def _preview_row(session: Session, f: Mapping[Any, Any]) -> RowMapping | None:
    """The file's own preview row, or, for an inherited file (spec §3.3b: same stored object), the first READY row
    along its inherited_from_file_id chain (bounded hops, as diff._profiles). Without a READY one the nearest existing
    row is used (own first), so a queued or failed state still shows. Access was checked on the requested file."""
    nearest: RowMapping | None = None
    current: UUID | None = f["file_id"]
    source: UUID | None = f["inherited_from_file_id"]
    for _ in range(MAX_INHERIT_HOPS):
        if current is None:
            break
        row = (
            session.execute(select(file_previews).where(file_previews.c.file_id == current))
            .mappings()
            .first()
        )
        if row is not None and row["status"] == "READY":
            return row
        nearest = nearest or row
        if source is None:
            break
        current = source
        source = session.execute(
            select(dataset_files.c.inherited_from_file_id).where(dataset_files.c.file_id == current)
        ).scalar_one_or_none()
    return nearest


def can_preview(user: CurrentUser, ds: Mapping[Any, Any], deps: CatalogDeps) -> bool:
    return (
        user.is_platform_admin
        or user.organization_id == ds["owner_organization_id"]
        or ds["access_level"] == "PUBLIC"
        or deps.grants.has_active_grant(user.user_id, ds["dataset_id"])
    )


def _status(f: Mapping[Any, Any], row: Mapping[Any, Any] | None) -> str:
    if row is None or table_format(f["path"]) is None:
        return "UNSUPPORTED"
    return str(row["status"])


def get_profile(session: Session, user: CurrentUser, file_id: UUID) -> dict[str, Any]:
    f, _, row = _load(session, user, file_id)
    status = _status(f, row)
    body: dict[str, Any] = {"file_id": file_id, "path": f["path"], "status": status, "columns": []}
    if row is not None:
        body.update(failure_code=row["failure_code"], generated_at=row["generated_at"])
    if status == "READY" and row is not None:
        profile = row["column_profile"]
        body.update(
            format=profile["format"],
            rows_sampled=profile["rows_sampled"],
            total_rows=profile.get("total_rows"),  # absent from profiles generated before Wave 1.5 Stage 2
            truncated=profile["truncated"],
            columns_truncated=profile["columns_truncated"],
            columns=profile["columns"],
        )
    return body


def get_preview(session: Session, deps: CatalogDeps, user: CurrentUser, file_id: UUID) -> dict[str, Any]:
    f, ds, row = _load(session, user, file_id)
    if not can_preview(user, ds, deps):
        raise ApiError(
            ErrorCode.FORBIDDEN,
            "접근 승인 후 미리보기를 볼 수 있습니다.",
            {"reason": "DOWNLOAD_PERMISSION_REQUIRED"},
        )
    status = _status(f, row)
    body: dict[str, Any] = {
        "file_id": file_id,
        "status": status,
        "header": [],
        "rows": [],
        "rows_truncated": False,
        "columns": [],
    }
    if status == "READY" and row is not None:
        preview = row["preview"]
        body.update(
            header=preview["header"],
            rows=preview["rows"],
            rows_truncated=preview["rows_truncated"],
            columns=preview["columns"],
        )
    return body
