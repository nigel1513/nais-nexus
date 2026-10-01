"""Constants and raw-SQL helpers shared by catalog tests."""

from collections.abc import Sequence
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text

from api.modules.catalog.domain import manifest_sha256, storage_key
from api.platform.db import session_factory
from api.platform.ids import new_id
from api.platform.testing.fixtures import PgUrls

ORG_NAIS = UUID("00000000-0000-7000-8000-000000000001")
ORG_A = UUID("00000000-0000-7000-8000-00000000000a")
ORG_B = UUID("00000000-0000-7000-8000-00000000000b")
SHA_A = "a" * 64


def seed_user_id(suffix: str) -> UUID:
    return UUID(f"00000000-0000-7000-8000-00000000{suffix}")


def rows(urls: PgUrls, sql: str, **params: Any) -> list[dict[str, Any]]:
    with session_factory(urls.app)() as session:
        return [dict(row) for row in session.execute(text(sql), params).mappings().all()]


def execute(urls: PgUrls, sql: str, **params: Any) -> int:
    with session_factory(urls.app)() as session, session.begin():
        return int(session.execute(text(sql), params).rowcount)  # type: ignore[attr-defined]


def outbox_events(urls: PgUrls, event_type: str | None = None) -> list[dict[str, Any]]:
    sql = "SELECT envelope FROM platform.outbox_events"
    if event_type:
        sql += " WHERE event_type = :event_type"
    return [row["envelope"] for row in rows(urls, sql + " ORDER BY id", event_type=event_type)]


def insert_dataset(
    urls: PgUrls,
    *,
    owner: UUID = ORG_B,
    access_level: str = "CONTROLLED",
    status: str = "ACTIVE",
    title: str = "Seeded dataset",
    max_grant_days: int = 180,
) -> UUID:
    dataset_id = new_id()
    execute(
        urls,
        "INSERT INTO catalog.datasets (dataset_id, owner_organization_id, title, access_level, license,"
        " allowed_purposes, approval_required, max_grant_days, status, created_by)"
        " VALUES (:id, :owner, :title, :level, 'CC-BY-4.0', ARRAY['ACADEMIC_RESEARCH'], :approval, :days,"
        " :status, :owner)",
        id=dataset_id,
        owner=owner,
        title=title,
        level=access_level,
        approval=access_level in ("CONTROLLED", "SENSITIVE"),
        days=max_grant_days,
        status=status,
    )
    return dataset_id


def _upload_session(urls: PgUrls, version_id: UUID) -> UUID:
    session_id = new_id()
    execute(
        urls,
        "INSERT INTO catalog.upload_sessions (upload_session_id, dataset_version_id, status, created_by,"
        " expires_at) VALUES (:id, :v, 'COMPLETED', :v, now() + interval '1 hour')",
        id=session_id,
        v=version_id,
    )
    return session_id


def insert_file(
    urls: PgUrls,
    version_id: UUID,
    *,
    path: str,
    size: int = 10,
    sha: str = SHA_A,
    status: str = "VERIFIED",
    bucket: str = "nais-inst-b",
) -> UUID:
    dataset_id = rows(
        urls, "SELECT dataset_id FROM catalog.dataset_versions WHERE dataset_version_id = :v", v=version_id
    )[0]["dataset_id"]
    file_id = new_id()
    session_id = _upload_session(urls, version_id)
    execute(
        urls,
        "INSERT INTO catalog.dataset_files (file_id, dataset_version_id, upload_session_id, path, size_bytes, sha256,"
        " media_type, storage_bucket, storage_key, status) VALUES (:id, :v, :s, :path, :size, :sha, 'text/csv',"
        " :bucket, :key, :status)",
        id=file_id,
        v=version_id,
        s=session_id,
        path=path,
        size=size,
        sha=sha,
        bucket=bucket,
        key=storage_key(dataset_id, version_id, session_id, path),
        status=status,
    )
    return file_id


def insert_version(
    urls: PgUrls,
    dataset_id: UUID,
    *,
    label: str = "v1",
    published: bool = False,
    files: Sequence[tuple[str, int, str]] = (),
    file_status: str = "VERIFIED",
    published_at: datetime | None = None,
) -> UUID:
    """A version inserted straight into the DB; published=True goes DRAFT -> PUBLISHED like the service does."""
    version_id = new_id()
    execute(
        urls,
        "INSERT INTO catalog.dataset_versions (dataset_version_id, dataset_id, version_label, created_by)"
        " VALUES (:v, :d, :label, :d)",
        v=version_id,
        d=dataset_id,
        label=label,
    )
    for path, size, sha in files:
        insert_file(urls, version_id, path=path, size=size, sha=sha, status=file_status)
    if published:
        execute(
            urls,
            "UPDATE catalog.dataset_versions SET status = 'PUBLISHED', manifest_sha256 = :manifest,"
            " metadata_snapshot = CAST(:snapshot AS jsonb), file_count = :count, total_bytes = :total,"
            " published_at = COALESCE(CAST(:at AS timestamptz), now()), published_by = :d"
            " WHERE dataset_version_id = :v",
            manifest=manifest_sha256(files),
            snapshot="{}",
            count=len(files),
            total=sum(size for _, size, _ in files),
            at=published_at,
            d=dataset_id,
            v=version_id,
        )
    return version_id


def enqueue(urls: PgUrls, dataset_id: UUID) -> None:
    execute(
        urls,
        "INSERT INTO catalog.index_queue (dataset_id) VALUES (:id)"
        " ON CONFLICT (dataset_id) DO UPDATE SET next_attempt_at = now(), attempts = 0",
        id=dataset_id,
    )
