"""getFileHistory and getDatasetCitation (spec §3.3b, §4)."""

from datetime import datetime
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from api.modules.catalog.access import can_see_all_versions, can_see_version, not_found, visible_dataset
from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.repo import load_dataset, load_version, must
from api.modules.catalog.service.snapshot import live_snapshot
from api.modules.catalog.tables import dataset_files, dataset_versions
from api.modules.catalog.versioning.citation import CitationInput, creators_from_snapshot, render
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode

# A dataset with more visible versions answers with the newest ones; the first entry's state still compares with
# its real predecessor.
MAX_HISTORY_VERSIONS = 1000

# The publication year a Korean institute would write: 2026-01-01 03:00 KST is 2026, although it is 2025 in UTC.
CITATION_TZ = ZoneInfo("Asia/Seoul")


def citation_year(published_at: datetime) -> int:
    return published_at.astimezone(CITATION_TZ).year


def _state(sha: str | None, previous: str | None) -> str:
    if sha is None:
        return "REMOVED" if previous is not None else "ABSENT"
    if previous is None:
        return "ADDED"
    return "UNCHANGED" if sha == previous else "CHANGED"


def file_history(session: Session, user: CurrentUser, dataset_id: UUID, path: str) -> dict[str, Any]:
    """The path's state in every PUBLISHED (and, for owner stewards/admins and platform admins, WITHDRAWN) version,
    oldest first (contract). UNCHANGED marks an inherited span (same sha256 as the previous version), CHANGED a
    real change. Two queries whatever the number of versions."""
    ds = visible_dataset(session, user, dataset_id)
    statuses = (
        ("PUBLISHED", "WITHDRAWN")
        if can_see_all_versions(user, ds["owner_organization_id"])
        else ("PUBLISHED",)
    )
    published_at = func.coalesce(dataset_versions.c.published_at, dataset_versions.c.created_at)
    newest = (
        session.execute(
            select(
                dataset_versions.c.dataset_version_id,
                dataset_versions.c.version_label,
                published_at.label("published_at"),
            )
            .where(dataset_versions.c.dataset_id == dataset_id, dataset_versions.c.status.in_(statuses))
            .order_by(published_at.desc(), dataset_versions.c.dataset_version_id.desc())
            .limit(MAX_HISTORY_VERSIONS + 1)  # one more: the predecessor of the oldest entry shown
        )
        .mappings()
        .all()
    )
    versions = list(reversed(newest))
    files = {
        r.dataset_version_id: r
        for r in session.execute(
            select(
                dataset_files.c.dataset_version_id, dataset_files.c.sha256, dataset_files.c.size_bytes
            ).where(
                dataset_files.c.dataset_version_id.in_([v["dataset_version_id"] for v in versions]),
                dataset_files.c.path == path,
            )
        )
    }
    items: list[dict[str, Any]] = []
    previous: str | None = None
    for index, v in enumerate(versions):
        row = files.get(v["dataset_version_id"])
        sha = row.sha256.strip() if row else None
        if index or len(versions) <= MAX_HISTORY_VERSIONS:
            items.append(
                {
                    "dataset_version_id": v["dataset_version_id"],
                    "version_label": v["version_label"],
                    "published_at": v["published_at"],
                    "state": _state(sha, previous),
                    "sha256": sha,
                    "size_bytes": int(row.size_bytes) if row else None,
                }
            )
        previous = sha
    return {"dataset_id": dataset_id, "path": path, "items": items}


def citation(
    session: Session, deps: CatalogDeps, user: CurrentUser, version_id: UUID, style: str
) -> dict[str, Any]:
    """A citation pinned to one version (its label and its version IRI). PUBLISHED or WITHDRAWN (a withdrawn
    version stays citable, as in the web mock); a DRAFT is 409 for those who can see it, 404 for everyone else."""
    version = load_version(session, version_id)
    if version is None:
        raise not_found("Dataset version")
    ds = must(load_dataset(session, version["dataset_id"]), "dataset")
    if not can_see_version(user, ds, version):
        raise not_found("Dataset version")
    if version["status"] == "DRAFT":
        raise ApiError(ErrorCode.DATASET_VERSION_NOT_PUBLISHED, "Only a published version can be cited.")
    # Frozen at publish (D-029): title, license and the people with their affiliations at that time.
    snapshot = version["metadata_snapshot"] or live_snapshot(session, deps, ds)
    org = deps.organizations.get_organization_summary(ds["owner_organization_id"])
    publisher = org.name if org else str(ds["owner_organization_id"])
    base = deps.settings.nais_public_base_url.rstrip("/")
    license_ = snapshot.get("license")
    content = render(
        style,
        CitationInput(
            title=str(snapshot.get("title") or ds["title"]),
            version_label=version["version_label"],
            year=citation_year(version["published_at"] or version["created_at"]),
            publisher=publisher,
            uri=f"{base}/id/dataset-version/{version_id}",
            doi=ds["doi"],
            license=license_ if isinstance(license_, str) else None,
            creators=creators_from_snapshot(snapshot, publisher),
        ),
    )
    return {"dataset_version_id": version_id, "style": style, "content": content}
