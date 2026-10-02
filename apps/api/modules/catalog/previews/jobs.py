"""Data Explorer generation: a scheduler job leases PENDING rows and sends catalog.generate_preview messages; the
actor profiles the object with bounded readers in a memory-limited child process (spec §7, 09 §1.4 limits,
controller ruling P24). A lost message is re-sent after the lease; after MAX_ATTEMPTS leases the row is FAILED."""

import logging
from collections.abc import Callable
from datetime import timedelta
from typing import Any
from uuid import UUID

import dramatiq
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.objects import ObjectMissing, StorageUnavailable
from api.modules.catalog.previews.profile import FieldHint, PreviewLimits
from api.modules.catalog.previews.sandbox import STARTUP_MARGIN_S, run_profile
from api.modules.catalog.previews.schema_hints import parse_schema_hints
from api.modules.catalog.settings import get_catalog_settings
from api.modules.catalog.tables import dataset_files, file_previews
from api.platform import clock, ports
from api.platform.storage import StorageNotConfigured

logger = logging.getLogger("nais.catalog.previews")
MAX_ATTEMPTS = 3
SCHEMA_MAX_BYTES = 1 << 20
DISPATCH_INTERVAL_S = 10.0


def dispatch_previews(
    deps: CatalogDeps, *, limit: int = 20, send: Callable[[str], None] | None = None
) -> int:
    sender = send or (lambda file_id: generate_preview_actor.send(file_id))
    now = clock.now()
    with deps.session_factory() as session, session.begin():
        due = session.execute(
            select(file_previews.c.file_id, file_previews.c.attempts)
            .where(file_previews.c.status == "PENDING", file_previews.c.next_attempt_at <= now)
            .order_by(file_previews.c.next_attempt_at)
            .limit(limit)
            .with_for_update(skip_locked=True)
        ).all()
        to_send: list[str] = []
        for row in due:
            if row.attempts >= MAX_ATTEMPTS:
                session.execute(
                    update(file_previews)
                    .where(file_previews.c.file_id == row.file_id)
                    .values(status="FAILED", failure_code="GENERATION_FAILED")
                )
                continue
            session.execute(
                update(file_previews)
                .where(file_previews.c.file_id == row.file_id)
                .values(
                    attempts=row.attempts + 1,
                    next_attempt_at=now + timedelta(seconds=deps.settings.catalog_preview_lease_seconds),
                )
            )
            to_send.append(str(row.file_id))
    for file_id in to_send:  # after commit
        sender(file_id)
    return len(to_send)


def _finish(session: Session, file_id: UUID, values: dict[str, Any]) -> None:
    session.execute(
        update(file_previews)
        .where(file_previews.c.file_id == file_id, file_previews.c.status == "PENDING")
        .values(**values)
    )


def generate_preview_job(file_id: UUID, *, deps: CatalogDeps) -> str:
    """Resulting status: READY / FAILED, PENDING (storage unavailable: the lease retries) or SKIPPED (no PENDING
    row). The parent never decodes the file: sandbox.run_profile does it in a child process."""
    with deps.session_factory() as session:
        row = (
            session.execute(
                select(
                    dataset_files.c.dataset_version_id,
                    dataset_files.c.path,
                    dataset_files.c.size_bytes,
                    dataset_files.c.storage_bucket,
                    dataset_files.c.storage_key,
                    file_previews.c.status.label("preview_status"),
                )
                .join(file_previews, file_previews.c.file_id == dataset_files.c.file_id)
                .where(dataset_files.c.file_id == file_id)
            )
            .mappings()
            .first()
        )
        schema = None
        if row is not None:
            schema = session.execute(
                select(dataset_files.c.storage_key, dataset_files.c.size_bytes).where(
                    dataset_files.c.dataset_version_id == row["dataset_version_id"],
                    dataset_files.c.path == "_schema.json",
                    dataset_files.c.status == "VERIFIED",
                )
            ).first()
    if row is None or row["preview_status"] != "PENDING":
        return "SKIPPED"
    settings = deps.settings
    try:
        store = deps.storage.for_bucket(row["storage_bucket"])
        hints: dict[str, FieldHint] = {}
        if schema is not None and 0 < schema.size_bytes <= SCHEMA_MAX_BYTES:
            raw = store.read_range(schema.storage_key, 0, int(schema.size_bytes) - 1)
            hints = parse_schema_hints(raw).get(row["path"], {})
        outcome = run_profile(
            lambda start, end: store.open_stream(row["storage_key"], (start, end)),
            int(row["size_bytes"]),
            path=row["path"],
            hints=hints,
            limits=PreviewLimits(
                max_rows=settings.catalog_preview_max_rows, max_bytes=settings.catalog_preview_max_bytes
            ),
            timeout_s=settings.catalog_preview_timeout_seconds,
            memory_limit=settings.catalog_preview_memory_limit_bytes,
        )
    except (StorageUnavailable, ObjectMissing, StorageNotConfigured):
        logger.warning("preview source unavailable; the lease will retry", extra={"file_id": str(file_id)})
        return "PENDING"
    values: dict[str, Any]
    if "result" in outcome:
        result = outcome["result"]
        status = "READY"
        values = {
            "status": "READY",
            "column_profile": {
                "format": result["format"],
                "rows_sampled": result["rows_sampled"],
                "truncated": result["truncated"],
                "columns_truncated": result["columns_truncated"],
                "columns": result["column_profile"],
            },
            "preview": result["preview"],
            "generated_at": clock.now(),
        }
    else:
        status = "FAILED"
        values = {"status": "FAILED", "failure_code": outcome["failure"]}
    with deps.session_factory() as session, session.begin():
        _finish(session, file_id, values)
    logger.info("file preview generated", extra={"file_id": str(file_id), "status": status})
    return status


_SETTINGS = get_catalog_settings()


@dramatiq.actor(
    queue_name="catalog",
    actor_name="catalog.generate_preview",
    max_retries=0,  # the lease (dispatch_previews) is the retry mechanism
    time_limit=int((_SETTINGS.catalog_preview_timeout_seconds + STARTUP_MARGIN_S + 60) * 1000),
)
def generate_preview_actor(file_id: str) -> None:
    generate_preview_job(UUID(file_id), deps=ports.get(CatalogDeps))
