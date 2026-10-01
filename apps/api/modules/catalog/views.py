"""Response bodies matching openapi components. Storage bucket/key and URLs never appear here (M03 §6.6)."""

from collections.abc import Mapping, Sequence
from typing import Any


def policy_view(ds: Mapping[Any, Any]) -> dict[str, Any]:
    return {
        "dataset_id": ds["dataset_id"],
        "owner_organization_id": ds["owner_organization_id"],
        "access_level": ds["access_level"],
        "allowed_purposes": list(ds["allowed_purposes"]),
        "approval_required": ds["approval_required"],
        "max_grant_days": ds["max_grant_days"],
    }


def version_summary(version: Mapping[Any, Any], readiness: str | None) -> dict[str, Any]:
    return {
        "dataset_version_id": version["dataset_version_id"],
        "version_label": version["version_label"],
        "status": version["status"],
        "published_at": version["published_at"],
        "readiness_overall": readiness,
    }


def dataset_view(
    ds: Mapping[Any, Any],
    *,
    org_name: str | None,
    latest: Mapping[Any, Any] | None,
    latest_readiness: str | None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "dataset_id": ds["dataset_id"],
        "owner_organization_id": ds["owner_organization_id"],
        "title": ds["title"],
        "description": ds["description"],
        "keywords": list(ds["keywords"]),
        "domain": ds["domain"],
        "access_level": ds["access_level"],
        "license": ds["license"],
        "usage_policy": ds["usage_policy"],
        "contact_email": ds["contact_email"],
        "provenance": ds["provenance"],
        "policy": policy_view(ds),
        "status": ds["status"],
        "latest_published_version": None if latest is None else version_summary(latest, latest_readiness),
        "created_by": ds["created_by"],
        "created_at": ds["created_at"],
        "updated_at": ds["updated_at"],
    }
    if org_name:
        body["owner_organization_name"] = org_name
    return body


def file_view(f: Mapping[Any, Any]) -> dict[str, Any]:
    return {
        "file_id": f["file_id"],
        "path": f["path"],
        "size_bytes": f["size_bytes"],
        "sha256": f["sha256"],
        "media_type": f["media_type"],
        "status": f["status"],
    }


def version_view(
    version: Mapping[Any, Any], files: Sequence[Mapping[Any, Any]], readiness: str | None
) -> dict[str, Any]:
    return {
        **version_summary(version, readiness),
        "dataset_id": version["dataset_id"],
        "change_note": version["change_note"],
        "files": [file_view(f) for f in files],
        "file_count": len(files),
        "total_bytes": sum(int(f["size_bytes"]) for f in files),
        "manifest_sha256": version["manifest_sha256"],
        "created_at": version["created_at"],
    }
