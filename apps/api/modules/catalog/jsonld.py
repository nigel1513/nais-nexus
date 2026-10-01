"""Machine-readable dataset metadata (Wave 1.5 spec §2): schema.org Dataset + DCAT + PROV context, for M11 / AI.

IRIs are minted under CatalogSettings.nais_public_base_url (never a hardcoded host). The only email that can appear is
the steward contact's, and only when contact_email_public is true (people_block enforces it)."""

from collections.abc import Mapping
from typing import Any

from sqlalchemy.orm import Session

from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.repo import latest_published_version
from api.modules.catalog.research import people_block
from api.modules.catalog.service.vocabulary import labels

CONTEXT = {
    "@vocab": "https://schema.org/",
    "dcat": "http://www.w3.org/ns/dcat#",
    "dct": "http://purl.org/dc/terms/",
    "prov": "http://www.w3.org/ns/prov#",
}


def _org(base: str, ref: Mapping[str, Any]) -> dict[str, Any]:
    if ref.get("organization_id"):
        return {
            "@type": "Organization",
            "@id": f"{base}/id/organization/{ref['organization_id']}",
            "name": ref["name"],
        }
    return {"@type": "Organization", "name": ref["name"]}


def _person(base: str, p: Mapping[str, Any]) -> dict[str, Any]:
    node: dict[str, Any] = {
        "@type": "Person",
        "@id": f"{base}/id/person/{p['user_id']}",
        "name": p["display_name"],
    }
    if p.get("national_researcher_number"):
        node["identifier"] = {
            "@type": "PropertyValue",
            "propertyID": "NTIS",
            "value": p["national_researcher_number"],
        }
    if p.get("affiliation"):
        node["affiliation"] = _org(base, p["affiliation"])
    if p.get("email"):
        node["email"] = p["email"]
    return node


def _terms(session: Session, base: str, scheme: str, codes: list[str]) -> list[dict[str, Any]]:
    found = labels(session, scheme, codes)
    out: list[dict[str, Any]] = []
    for code in codes:
        row = found.get(code, {})
        term: dict[str, Any] = {
            "@type": "DefinedTerm",
            "@id": f"{base}/vocabulary/{scheme}/{code}",  # Ruling P7
            "termCode": code,
            "name": row.get("label_ko", code),
            "inDefinedTermSet": f"{base}/vocabulary/{scheme}",
        }
        if row.get("iri"):
            term["sameAs"] = row["iri"]
        out.append(term)
    return out


def _citation(publication: Mapping[str, Any]) -> dict[str, Any]:
    node: dict[str, Any] = {"@type": "ScholarlyArticle", "name": publication["title"]}
    if publication.get("doi"):
        node["sameAs"] = f"https://doi.org/{publication['doi']}"
    elif publication.get("url"):
        node["url"] = publication["url"]
    return node


def _org_name(deps: CatalogDeps, org_id: Any) -> str:
    summary = deps.organizations.get_organization_summary(org_id)
    return summary.name if summary else str(org_id)


def dataset_jsonld(session: Session, deps: CatalogDeps, ds: Mapping[Any, Any]) -> dict[str, Any]:
    base = deps.settings.nais_public_base_url.rstrip("/")
    people = people_block(session, deps, ds)
    latest = latest_published_version(session, ds["dataset_id"])
    owner = {
        "organization_id": ds["owner_organization_id"],
        "name": _org_name(deps, ds["owner_organization_id"]),
    }
    pi = people["principal_investigator"]
    doc: dict[str, Any] = {
        "@context": CONTEXT,
        "@type": ["Dataset", "dcat:Dataset"],
        "@id": f"{base}/id/dataset/{ds['dataset_id']}",
        "identifier": str(ds["dataset_id"]),
        "name": ds["title"],
        "description": ds["description"],
        "keywords": list(ds["keywords"] or []),
        "license": ds["license"],
        "conditionsOfAccess": ds["access_level"],
        "dateCreated": ds["created_at"].isoformat(),
        "dateModified": ds["updated_at"].isoformat(),
        "dct:accrualPeriodicity": ds["update_frequency"],
        "publisher": _org(base, owner),
        "about": _terms(session, base, "SUBJECT", list(ds["subject_codes"] or []))
        + _terms(session, base, "MATERIAL", list(ds["material_codes"] or [])),
        "measurementTechnique": _terms(session, base, "METHOD", list(ds["method_codes"] or [])),
        "creator": [_person(base, pi)] if pi else [],
        "contributor": [{**_person(base, c), "roleName": c["role"]} for c in people["contributors"]],
        "citation": [_citation(p) for p in ds["related_publications"] or []],
    }
    if people["steward_contact"]:
        doc["maintainer"] = _person(base, people["steward_contact"])
    if ds["subtitle"]:
        doc["alternativeHeadline"] = ds["subtitle"]
    if ds["usage_policy"]:
        doc["usageInfo"] = ds["usage_policy"]
    if ds["temporal_start"]:
        end = ds["temporal_end"].isoformat() if ds["temporal_end"] else ".."
        doc["temporalCoverage"] = f"{ds['temporal_start'].isoformat()}/{end}"
    if ds["collecting_organization_id"]:
        org_id = ds["collecting_organization_id"]
        doc["sourceOrganization"] = _org(base, {"organization_id": org_id, "name": _org_name(deps, org_id)})
    elif ds["collecting_organization_name"]:
        doc["sourceOrganization"] = _org(base, {"name": ds["collecting_organization_name"]})
    if ds["funding_agency"]:
        doc["funder"] = {"@type": "Organization", "name": ds["funding_agency"]}
    if ds["project_title"] or ds["project_code"]:
        doc["isPartOf"] = {
            "@type": "ResearchProject",
            "name": ds["project_title"],
            "identifier": ds["project_code"],
        }
    if ds["method_detail"]:
        doc["prov:wasGeneratedBy"] = {"@type": "prov:Activity", "description": ds["method_detail"]}
    if latest:
        doc["version"] = latest["version_label"]
        doc["datePublished"] = latest["published_at"].isoformat()
    if ds["doi"]:
        doc["sameAs"] = f"https://doi.org/{ds['doi']}"
    return doc
