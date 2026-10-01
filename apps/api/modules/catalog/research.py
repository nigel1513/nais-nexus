"""Research metadata rules (Wave 1.5 spec §3.0b, §3.2): eligibility of persons, vocabulary codes, period,
collecting organization, and the people block with at-the-time vs current affiliation.

Emails: only the steward contact's, only when contact_email_public is true and the steward is still an ACTIVE member
of the owner organization (an absent steward never exposes an address). No other person's email is ever returned."""

from collections.abc import Mapping
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.interfaces import PersonSummary
from api.modules.catalog.service.vocabulary import active_codes
from api.modules.catalog.tables import dataset_contributors
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode

RESEARCH_FIELDS: tuple[str, ...] = (
    "subtitle",
    "principal_investigator_id",
    "data_steward_contact_id",
    "contact_email_public",
    "project_title",
    "project_code",
    "funding_agency",
    "subject_codes",
    "method_codes",
    "material_codes",
    "method_detail",
    "temporal_start",
    "temporal_end",
    "collecting_organization_id",
    "collecting_organization_name",
    "update_frequency",
    "related_publications",
)
SCHEMES = {"subject_codes": "SUBJECT", "method_codes": "METHOD", "material_codes": "MATERIAL"}
PEOPLE = {
    "principal_investigator_id": "principal_investigator_org_id",
    "data_steward_contact_id": "data_steward_contact_org_id",
}


def _eligible_member(person: PersonSummary | None, owner: UUID) -> bool:
    return person is not None and person.status == "ACTIVE" and person.organization_id == owner


def _merged(values: Mapping[Any, Any], current: Mapping[Any, Any] | None, field: str) -> Any:
    if field in values:
        return values[field]
    return current[field] if current is not None else None


def validate_research(
    session: Session,
    deps: CatalogDeps,
    owner: UUID,
    values: Mapping[Any, Any],
    *,
    current: Mapping[Any, Any] | None = None,
) -> dict[str, Any]:
    """Return DB-ready values (adds *_org_id for newly assigned persons). Raises one 422 listing every problem.

    current is the stored dataset row on update (PATCH semantics: cross-field rules run on the merged result). A person
    re-saved unchanged is not re-checked, so a historic PI who has since moved stays valid and keeps the at-the-time
    affiliation."""
    problems: list[dict[str, str]] = []
    out = dict(values)
    assigned = [
        field
        for field in PEOPLE
        if values.get(field) is not None and (current is None or values[field] != current[field])
    ]
    people = deps.organizations.get_people([values[field] for field in assigned])
    for field in assigned:
        person = people.get(values[field])
        if person is None or not _eligible_member(person, owner):
            problems.append({"field": field, "reason": "PERSON_NOT_ELIGIBLE"})
        else:
            out[PEOPLE[field]] = person.organization_id  # at-the-time affiliation
    for field, scheme in SCHEMES.items():
        codes = values.get(field)
        if codes and set(codes) - active_codes(session, scheme):
            problems.append({"field": field, "reason": "VOCABULARY_TERM_UNKNOWN"})
    start = _merged(values, current, "temporal_start")
    end = _merged(values, current, "temporal_end")
    if start is not None and end is not None and end < start:
        problems.append({"field": "temporal_end", "reason": "TEMPORAL_RANGE"})
    org_id = _merged(values, current, "collecting_organization_id")
    org_name = _merged(values, current, "collecting_organization_name")
    if org_id is not None and org_name is not None:
        problems.append({"field": "collecting_organization_name", "reason": "MUTUALLY_EXCLUSIVE"})
    new_org = values.get("collecting_organization_id")
    if new_org is not None and deps.organizations.get_organization_summary(new_org) is None:
        problems.append({"field": "collecting_organization_id", "reason": "UNKNOWN_ORGANIZATION"})
    if problems:
        raise ApiError(ErrorCode.VALIDATION_FAILED, "Research metadata is invalid.", {"fields": problems})
    if out.get("related_publications") is not None:
        out["related_publications"] = [
            {key: value for key, value in publication.items() if value is not None}
            for publication in out["related_publications"]
        ]
    return out


def _org_ref(deps: CatalogDeps, org_id: UUID | None, cache: dict[UUID, str]) -> dict[str, Any] | None:
    if org_id is None:
        return None
    if org_id not in cache:
        summary = deps.organizations.get_organization_summary(org_id)
        cache[org_id] = summary.name if summary else str(org_id)
    return {"organization_id": org_id, "name": cache[org_id]}


def _person(
    deps: CatalogDeps,
    user_id: UUID,
    affiliation: UUID,
    found: Mapping[UUID, PersonSummary],
    cache: dict[UUID, str],
) -> dict[str, Any]:
    person = found.get(user_id)
    return {
        "user_id": user_id,
        "display_name": person.display_name if person else str(user_id),
        "national_researcher_number": person.national_researcher_number if person else None,
        "status": person.status if person else "DISABLED",
        "affiliation": _org_ref(deps, affiliation, cache),
        "current_organization": _org_ref(deps, person.organization_id, cache) if person else None,
    }


def contributor_rows(session: Session, dataset_id: UUID) -> list[Mapping[Any, Any]]:
    return list(
        session.execute(
            select(dataset_contributors)
            .where(dataset_contributors.c.dataset_id == dataset_id)
            .order_by(dataset_contributors.c.position)
        ).mappings()
    )


def collecting_organization(deps: CatalogDeps, ds: Mapping[Any, Any]) -> dict[str, Any] | None:
    if ds["collecting_organization_id"] is not None:
        return _org_ref(deps, ds["collecting_organization_id"], {})
    if ds["collecting_organization_name"] is not None:
        return {"organization_id": None, "name": ds["collecting_organization_name"]}
    return None


def people_block(session: Session, deps: CatalogDeps, ds: Mapping[Any, Any]) -> dict[str, Any]:
    """openapi DatasetPeople."""
    contributors = contributor_rows(session, ds["dataset_id"])
    pi_id = ds["principal_investigator_id"]
    steward_id = ds["data_steward_contact_id"]
    ids = [i for i in (pi_id, steward_id) if i is not None] + [c["user_id"] for c in contributors]
    found = deps.organizations.get_people(ids) if ids else {}
    cache: dict[UUID, str] = {}
    pi = _person(deps, pi_id, ds["principal_investigator_org_id"], found, cache) if pi_id else None
    steward = (
        _person(deps, steward_id, ds["data_steward_contact_org_id"], found, cache) if steward_id else None
    )
    absent = steward_id is None or not _eligible_member(found.get(steward_id), ds["owner_organization_id"])
    if steward is not None and ds["contact_email_public"] and not absent:
        email = deps.organizations.get_email(steward_id)
        if email:
            steward["email"] = email
    return {
        "principal_investigator": pi,
        "steward_contact": steward,
        "contributors": [
            {**_person(deps, c["user_id"], c["affiliation_organization_id"], found, cache), "role": c["role"]}
            for c in contributors
        ],
        "steward_contact_absent": absent,
    }
