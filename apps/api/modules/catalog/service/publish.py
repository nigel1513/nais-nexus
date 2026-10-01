"""publishDatasetVersion (M03 §6.9): one transaction freezes manifest + metadata and emits the event."""

from collections.abc import Mapping
from typing import Any
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from api.modules.catalog.access import require_draft, steward_version
from api.modules.catalog.domain import SNAPSHOT_FIELDS, manifest_sha256
from api.modules.catalog.repo import enqueue_index, load_version, must
from api.modules.catalog.service.versions import version_response
from api.modules.catalog.tables import dataset_files, dataset_versions
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.events import EventActor
from api.platform.generated.error_codes import ErrorCode
from api.platform.outbox import outbox

LIST_FIELDS = frozenset({"keywords", "allowed_purposes"})


def metadata_snapshot(ds: Mapping[Any, Any]) -> dict[str, Any]:
    """Dataset metadata frozen at publish; M05 evaluates this, never the live dataset (D-029)."""
    return {
        field: list(ds[field]) if field in LIST_FIELDS else ds[field] for field in sorted(SNAPSHOT_FIELDS)
    }


def finalize_publish(
    session: Session,
    *,
    ds: Mapping[Any, Any],
    version: Mapping[Any, Any],
    published_by: UUID,
    actor: EventActor,
) -> None:
    version_id = version["dataset_version_id"]
    files = (
        session.execute(
            select(dataset_files)
            .where(dataset_files.c.dataset_version_id == version_id)
            .order_by(dataset_files.c.path.collate("C"))
        )
        .mappings()
        .all()
    )
    not_ready = [f for f in files if f["status"] != "VERIFIED"]
    if not files or not_ready:
        raise ApiError(
            ErrorCode.DATASET_VERSION_INCOMPLETE,
            "Publishing needs at least one file and every file VERIFIED.",
            {
                "files": [
                    {"file_id": str(f["file_id"]), "path": f["path"], "status": f["status"]}
                    for f in not_ready
                ]
            },
        )
    manifest = manifest_sha256((f["path"], int(f["size_bytes"]), f["sha256"].strip()) for f in files)
    total_bytes = sum(int(f["size_bytes"]) for f in files)
    now = clock.now()
    session.execute(
        update(dataset_versions)
        .where(dataset_versions.c.dataset_version_id == version_id, dataset_versions.c.status == "DRAFT")
        .values(
            status="PUBLISHED",
            manifest_sha256=manifest,
            metadata_snapshot=metadata_snapshot(ds),
            file_count=len(files),
            total_bytes=total_bytes,
            published_at=now,
            published_by=published_by,
            updated_at=now,
        )
    )
    outbox.write(
        session,
        "catalog.dataset.version_published.v1",
        {
            "dataset_id": str(ds["dataset_id"]),
            "dataset_version_id": str(version_id),
            "version_label": version["version_label"],
            "owner_organization_id": str(ds["owner_organization_id"]),
            "file_count": len(files),
            "total_bytes": total_bytes,
            "manifest_sha256": manifest,
        },
        actor,
    )
    enqueue_index(session, ds["dataset_id"])


def publish_version(session: Session, user: CurrentUser, version_id: UUID) -> dict[str, Any]:
    version, ds = steward_version(session, user, version_id, for_update=True)
    require_draft(version)
    finalize_publish(
        session, ds=ds, version=version, published_by=user.user_id, actor=EventActor.for_user(user)
    )
    return version_response(session, must(load_version(session, version_id), "version"))
