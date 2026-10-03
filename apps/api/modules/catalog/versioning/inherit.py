"""Zero-copy inheritance (spec §3.3b): a draft's files point at the source version's stored objects.

Shared-object protocol (a): rows are copied only from PUBLISHED versions of the same dataset. The check
(`refs.require_inheritable`) runs in the inserting transaction after the target version's row lock, so no other
writer of the target version interleaves; published sources cannot change or disappear (catalog triggers), so no
object locks are needed."""

from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import insert, select
from sqlalchemy.orm import Session

from api.modules.catalog.tables import dataset_files, dataset_versions
from api.modules.catalog.versioning.refs import require_inheritable
from api.platform.ids import new_id

COPIED = (
    "path",
    "size_bytes",
    "sha256",
    "media_type",
    "storage_bucket",
    "storage_key",
    "scan_status",
    "verified_at",
)


def copy_rows(
    session: Session, source_rows: Sequence[Mapping[Any, Any]], *, to_version_id: UUID, now: datetime
) -> int:
    """Insert one inherited row per source row (status VERIFIED, no upload session, same stored object).

    Raises `InheritanceViolation` (and inserts nothing) if any source is not a PUBLISHED row of the target's
    dataset."""
    session.execute(
        select(dataset_versions.c.dataset_version_id)
        .where(dataset_versions.c.dataset_version_id == to_version_id)
        .with_for_update()
    )
    require_inheritable(session, [src["file_id"] for src in source_rows], to_version_id=to_version_id)
    values = [
        {
            **{c: src[c] for c in COPIED},
            "file_id": new_id(),
            "dataset_version_id": to_version_id,
            "upload_session_id": None,
            "inherited_from_file_id": src["file_id"],
            "multipart_upload_id": None,
            "part_size_bytes": None,
            "status": "VERIFIED",
            "failure_code": None,
            "created_at": now,
            "updated_at": now,
        }
        for src in source_rows
    ]
    if values:
        session.execute(insert(dataset_files), values)
    return len(values)


def copy_files(session: Session, *, from_version_id: UUID, to_version_id: UUID, now: datetime) -> int:
    """Inherit every file of `from_version_id` (a PUBLISHED version of the same dataset) into `to_version_id`."""
    source = (
        session.execute(select(dataset_files).where(dataset_files.c.dataset_version_id == from_version_id))
        .mappings()
        .all()
    )
    return copy_rows(session, source, to_version_id=to_version_id, now=now)
