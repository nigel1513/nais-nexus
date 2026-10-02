"""DB -> nais-datasets document (M03 §10 mapping). The DB is the system of record; documents are rebuilt."""

from collections.abc import Sequence
from datetime import date, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.orm import Session

from api.modules.catalog.interfaces import OrganizationLookup
from api.modules.catalog.repo import readiness_overall
from api.modules.catalog.service.vocabulary import labels
from api.modules.catalog.tables import dataset_versions, datasets

SNIPPET_CHARS = 300
CODE_FIELDS = (("SUBJECT", "subject_codes"), ("MATERIAL", "material_codes"), ("METHOD", "method_codes"))


def _iso(value: datetime | None) -> str | None:
    return None if value is None else value.isoformat()


def _day(value: date | None) -> str | None:
    return None if value is None else value.isoformat()


def _str(value: UUID | None) -> str | None:
    return None if value is None else str(value)


def build_documents(
    session: Session, organizations: OrganizationLookup, dataset_ids: Sequence[UUID]
) -> tuple[list[dict[str, Any]], list[str]]:
    ids = list(dict.fromkeys(dataset_ids))
    found = {
        row["dataset_id"]: row
        for row in session.execute(select(datasets).where(datasets.c.dataset_id.in_(ids))).mappings()
    }
    deletes = [str(i) for i in ids if i not in found or found[i]["status"] != "ACTIVE"]
    active = [found[i] for i in ids if i in found and found[i]["status"] == "ACTIVE"]
    if not active:
        return [], deletes
    latest = {
        row["dataset_id"]: row
        for row in session.execute(
            select(dataset_versions)
            .ext(distinct_on(dataset_versions.c.dataset_id))
            .where(
                dataset_versions.c.dataset_id.in_([d["dataset_id"] for d in active]),
                dataset_versions.c.status == "PUBLISHED",
            )
            .order_by(
                dataset_versions.c.dataset_id,
                dataset_versions.c.published_at.desc(),
                dataset_versions.c.dataset_version_id.desc(),
            )
        ).mappings()
    }
    readiness = readiness_overall(session, [v["dataset_version_id"] for v in latest.values()])
    orgs = organizations.get_organization_summaries(
        list(
            {d["owner_organization_id"] for d in active}
            | {d["collecting_organization_id"] for d in active if d["collecting_organization_id"]}
        )
    )
    people = organizations.get_people(
        list({d["principal_investigator_id"] for d in active if d["principal_investigator_id"]})
    )
    term_labels = {
        scheme: labels(session, scheme, sorted({code for d in active for code in d[field] or ()}))
        for scheme, field in CODE_FIELDS
    }
    docs: list[dict[str, Any]] = []
    for ds in active:
        version = latest.get(ds["dataset_id"])
        org = orgs.get(ds["owner_organization_id"])
        collecting = orgs.get(ds["collecting_organization_id"]) if ds["collecting_organization_id"] else None
        collecting_name = collecting.name if collecting else ds["collecting_organization_name"]
        pi = people.get(ds["principal_investigator_id"]) if ds["principal_investigator_id"] else None
        docs.append(
            {
                "dataset_id": str(ds["dataset_id"]),
                "title": ds["title"],
                "description": ds["description"],
                "snippet": ds["description"][:SNIPPET_CHARS],
                "keywords": list(ds["keywords"]),
                "domain": ds["domain"],
                "access_level": ds["access_level"],
                "owner_organization_id": str(ds["owner_organization_id"]),
                "owner_organization_name": org.name if org else "",
                "allowed_purposes": list(ds["allowed_purposes"]),
                "license": ds["license"],
                "status": ds["status"],
                "has_published_version": version is not None,
                "latest_version_id": str(version["dataset_version_id"]) if version else None,
                "latest_version_label": version["version_label"] if version else None,
                "readiness_overall": readiness.get(version["dataset_version_id"]) if version else None,
                "published_at": _iso(version["published_at"]) if version else None,
                "updated_at": _iso(ds["updated_at"]),
                "subtitle": ds["subtitle"],
                "subject_codes": list(ds["subject_codes"] or []),
                "material_codes": list(ds["material_codes"] or []),
                "method_codes": list(ds["method_codes"] or []),
                "subject_labels": " ".join(
                    f"{term['label_ko']} {term['label_en']}"
                    for scheme, field in CODE_FIELDS
                    for code in ds[field] or ()
                    if (term := term_labels[scheme].get(code))
                ),
                "temporal_start": _day(ds["temporal_start"]),
                "temporal_end": _day(ds["temporal_end"]),
                "collecting_organization_id": _str(ds["collecting_organization_id"]),
                "collecting_organization_name": collecting_name,
                "principal_investigator_id": _str(ds["principal_investigator_id"]),
                "principal_investigator_name": pi.display_name if pi else None,
            }
        )
    return docs, deletes
