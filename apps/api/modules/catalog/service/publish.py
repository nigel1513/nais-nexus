"""publishDatasetVersion (M03 §6.9): one transaction freezes manifest + metadata and emits the event."""

import json
from collections.abc import Mapping
from datetime import date
from typing import Any
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from api.modules.catalog.access import require_draft, steward_version
from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.domain import SNAPSHOT_FIELDS, manifest_sha256
from api.modules.catalog.previews.store import queue_previews
from api.modules.catalog.repo import enqueue_index, load_dataset, load_version, must
from api.modules.catalog.research import people_block
from api.modules.catalog.service.versions import version_response
from api.modules.catalog.tables import dataset_files, dataset_versions
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.events import EventActor
from api.platform.generated.error_codes import ErrorCode
from api.platform.outbox import outbox

LIST_FIELDS = frozenset(
    {
        "keywords",
        "allowed_purposes",
        "subject_codes",
        "method_codes",
        "material_codes",
        "related_publications",
    }
)


def _plain(value: Any) -> Any:
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, UUID):
        return str(value)
    return value


def metadata_snapshot(
    ds: Mapping[Any, Any], people: dict[str, Any], fallback_email: str | None
) -> dict[str, Any]:
    """Dataset metadata frozen at publish; M05 evaluates this, never the live dataset (D-029).

    fallback_email is the steward contact's email only when contact_email_public is true (Ruling P23): the snapshot is
    visible metadata, so a private account email never enters it. people carries no emails at all."""
    snap = {
        field: list(ds[field] or []) if field in LIST_FIELDS else _plain(ds[field])
        for field in sorted(SNAPSHOT_FIELDS)
    }
    snap["contact_email"] = ds["contact_email"] or fallback_email
    snap["domain"] = ds["domain"] or (ds["subject_codes"][0] if ds["subject_codes"] else None)
    snap["people"] = json.loads(json.dumps(people, default=str))  # UUIDs -> str
    return snap


def _snapshot_people(
    session: Session, deps: CatalogDeps, ds: Mapping[Any, Any]
) -> tuple[dict[str, Any], str | None]:
    """people block without emails + the public steward email (people_block exposes it only when
    contact_email_public is true and the steward is still an ACTIVE member of the owner organization)."""
    people = people_block(session, deps, ds)
    public_email = people["steward_contact"].pop("email", None) if people["steward_contact"] else None
    return people, public_email


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
    people, public_email = _snapshot_people(session, deps, ds)
    now = clock.now()
    session.execute(
        update(dataset_versions)
        .where(dataset_versions.c.dataset_version_id == version_id, dataset_versions.c.status == "DRAFT")
        .values(
            status="PUBLISHED",
            manifest_sha256=manifest,
            metadata_snapshot=metadata_snapshot(ds, people, public_email),
            file_count=len(files),
            total_bytes=total_bytes,
            published_at=now,
            published_by=published_by,
            updated_at=now,
        )
    )
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
    finalize_publish(
        session,
        ds=ds,
        version=version,
        published_by=user.user_id,
        actor=EventActor.for_user(user),
        deps=deps,
    )
    return version_response(session, must(load_version(session, version_id), "version"))
