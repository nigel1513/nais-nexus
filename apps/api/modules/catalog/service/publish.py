"""publishDatasetVersion (M03 §6.9): one transaction freezes manifest + metadata and emits the event."""

from collections.abc import Mapping
from typing import Any
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from api.modules.catalog.access import require_draft, steward_version
from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.domain import manifest_sha256
from api.modules.catalog.previews.store import inherit_previews, queue_previews
from api.modules.catalog.repo import enqueue_index, latest_published_version, load_dataset, load_version, must
from api.modules.catalog.service.snapshot import live_snapshot, plain_value
from api.modules.catalog.service.versions import version_response
from api.modules.catalog.tables import dataset_files, dataset_versions
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.events import EventActor
from api.platform.generated.error_codes import ErrorCode
from api.platform.outbox import outbox


def require_publishable(session: Session, version: Mapping[Any, Any], ds: Mapping[Any, Any]) -> None:
    """Change note, then a current base (spec §3.3, §3.3b). Called with the version and dataset rows locked
    (version -> dataset), so the latest PUBLISHED version cannot move under us; a concurrent publisher of another
    draft of the same dataset waits on the dataset lock and then sees this one as its new latest.

    A NULL base (a draft created before anything was published) is stale as soon as any version is published."""
    if len((version["change_note"] or "").strip()) < 3:
        raise ApiError(
            ErrorCode.DATASET_VERSION_INCOMPLETE,
            "A change note (3-2000 characters) is required to publish.",
            {"reasons": ["CHANGE_NOTE_REQUIRED"]},
        )
    latest = latest_published_version(session, ds["dataset_id"])
    latest_id = None if latest is None else latest["dataset_version_id"]
    if version["base_version_id"] != latest_id:
        raise ApiError(
            ErrorCode.DATASET_VERSION_STALE_BASE,
            "A newer version was published after this draft was created; update the draft first.",
            {
                "base_version_id": plain_value(version["base_version_id"]),
                "latest_version_id": plain_value(latest_id),
            },
        )


def finalize_publish(
    session: Session,
    *,
    ds: Mapping[Any, Any],
    version: Mapping[Any, Any],
    published_by: UUID,
    actor: EventActor,
    deps: CatalogDeps,
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
    latest = latest_published_version(session, ds["dataset_id"])  # before this version becomes the latest
    now = clock.now()
    session.execute(
        update(dataset_versions)
        .where(dataset_versions.c.dataset_version_id == version_id, dataset_versions.c.status == "DRAFT")
        .values(
            status="PUBLISHED",
            manifest_sha256=manifest,
            metadata_snapshot=live_snapshot(session, deps, ds),
            file_count=len(files),
            total_bytes=total_bytes,
            published_at=now,
            published_by=published_by,
            previous_version_id=None if latest is None else latest["dataset_version_id"],
            updated_at=now,
        )
    )
    # Inherited files are the source's object: reuse its finished profile; queue the rest (on conflict: skip).
    inherit_previews(session, version_id)
    queue_previews(session, version_id)
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


def publish_version(
    session: Session, deps: CatalogDeps, user: CurrentUser, version_id: UUID
) -> dict[str, Any]:
    version, _ = steward_version(session, user, version_id, for_update=True)
    require_draft(version)
    # Lock order version -> dataset: a concurrent updateDataset waits, so the frozen snapshot is current (D-029).
    ds = must(load_dataset(session, version["dataset_id"], for_update=True), "dataset")
    if ds["status"] == "WITHDRAWN":
        raise ApiError(ErrorCode.CONFLICT, "WITHDRAWN datasets cannot publish versions.")
    require_publishable(session, version, ds)  # then finalize_publish checks completeness
    finalize_publish(
        session,
        ds=ds,
        version=version,
        published_by=user.user_id,
        actor=EventActor.for_user(user),
        deps=deps,
    )
    # Only an owner-org steward publishes: they see every version of the dataset.
    return version_response(
        session, must(load_version(session, version_id), "version"), sees_all_versions=True
    )
