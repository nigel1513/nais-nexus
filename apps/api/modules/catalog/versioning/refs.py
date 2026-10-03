"""Stored-object references (spec §3.3b). Several file rows may share one object (zero-copy drafts); an object is
deleted only after commit and only when no row references it any more.

Why this is enough: rows are only ever *copied* from PUBLISHED versions of the same dataset (`require_inheritable`),
whose rows can never be deleted (catalog.files_immutable / versions_immutable). An object shared with a published
row therefore always keeps a reference. The advisory lock serializes two transactions that remove the last two
references at the same time: the second one waits for the first to commit, and its reference check (a new statement
under READ COMMITTED) then sees the first one's delete."""

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import exists, select, text
from sqlalchemy.orm import Session

from api.modules.catalog.tables import dataset_files, dataset_versions


@dataclass(frozen=True)
class StorageCleanup:
    """An object (and optional multipart upload) to remove best-effort AFTER the transaction committed."""

    bucket: str
    key: str
    multipart_upload_id: str | None = None


def cleanup_target(f: Mapping[Any, Any]) -> StorageCleanup:
    upload_id = f["multipart_upload_id"] if f["status"] in ("PENDING", "FAILED") else None
    return StorageCleanup(f["storage_bucket"], f["storage_key"], upload_id)


class InheritanceViolation(ValueError):
    """A row would inherit from a file outside a PUBLISHED version of the same dataset (a programming error)."""


def require_inheritable(session: Session, source_file_ids: Iterable[UUID], *, to_version_id: UUID) -> None:
    """Service-level guard for inherited rows (the FK alone allows any file): every source must belong to a
    PUBLISHED version of the target version's dataset. This is what keeps `release_objects` safe."""
    ids = set(source_file_ids)
    if not ids:
        return
    target_dataset = (
        select(dataset_versions.c.dataset_id)
        .where(dataset_versions.c.dataset_version_id == to_version_id)
        .scalar_subquery()
    )
    ok: set[UUID] = set(
        session.execute(
            select(dataset_files.c.file_id)
            .select_from(
                dataset_files.join(
                    dataset_versions,
                    dataset_files.c.dataset_version_id == dataset_versions.c.dataset_version_id,
                )
            )
            .where(
                dataset_files.c.file_id.in_(ids),
                dataset_versions.c.status == "PUBLISHED",
                dataset_versions.c.dataset_id == target_dataset,
            )
        ).scalars()
    )
    bad = ids - ok
    if bad:
        raise InheritanceViolation(
            f"files {sorted(map(str, bad))} are not in a PUBLISHED version of the dataset of {to_version_id}"
        )


def lock_objects(session: Session, objects: Iterable[tuple[str, str]]) -> None:
    """Transaction-scoped locks in sorted order (no deadlock between two releasers)."""
    for bucket, key in sorted(set(objects)):
        session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"),
            {"k": f"catalog-object:{bucket}/{key}"},
        )


class IsolationViolation(RuntimeError):
    """`release_objects` ran in a transaction that is not READ COMMITTED (a programming error)."""


def require_read_committed(session: Session) -> None:
    """Shared-object protocol (g): the reference check after the advisory lock must see rows committed by the
    transaction that held the lock before us. Under REPEATABLE READ / SERIALIZABLE the snapshot is taken at the
    first statement, so a concurrent last-reference delete would stay invisible and the object would leak (or,
    worse, two releasers would both see the other's row)."""
    level: str = session.execute(text("SHOW transaction_isolation")).scalar_one()
    if level != "read committed":
        raise IsolationViolation(f"release_objects needs READ COMMITTED, the transaction runs at {level}")


def release_objects(session: Session, old_rows: Sequence[Mapping[Any, Any]]) -> list[StorageCleanup]:
    """Call after `old_rows` were deleted or re-pointed in this transaction, exactly once and last. Returns the
    cleanups (to run after commit) for objects that no row references any more; a still-shared object is kept."""
    require_read_committed(session)
    by_object = {(r["storage_bucket"], r["storage_key"]): r for r in old_rows}
    lock_objects(session, by_object)
    cleanups: list[StorageCleanup] = []
    for (bucket, key), row in sorted(by_object.items()):
        referenced = session.execute(
            select(
                exists().where(dataset_files.c.storage_bucket == bucket, dataset_files.c.storage_key == key)
            )
        ).scalar_one()
        if not referenced:
            cleanups.append(cleanup_target(row))
    return cleanups
