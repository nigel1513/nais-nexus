"""Frozen dataset metadata (D-029): the snapshot publish stores, and the live one a DRAFT is compared with."""

import json
from collections.abc import Mapping
from datetime import date
from typing import Any
from uuid import UUID

from sqlalchemy.orm import Session

from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.domain import SNAPSHOT_FIELDS
from api.modules.catalog.research import people_block

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


def plain_value(value: Any) -> Any:
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
        field: list(ds[field] or []) if field in LIST_FIELDS else plain_value(ds[field])
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


def live_snapshot(session: Session, deps: CatalogDeps, ds: Mapping[Any, Any]) -> dict[str, Any]:
    """What publishing now would freeze (finalize_publish stores exactly this; the diff layer compares drafts with
    it). No private email ever enters it (Ruling P23)."""
    people, public_email = _snapshot_people(session, deps, ds)
    return metadata_snapshot(ds, people, public_email)
