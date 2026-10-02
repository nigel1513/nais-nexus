"""Controlled vocabulary (spec §3.1): list active terms, PLATFORM_ADMIN adds terms."""

from typing import Any

from sqlalchemy import insert, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.modules.catalog.schemas import VocabularyTermIn
from api.modules.catalog.tables import vocabulary_terms
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.ids import new_id

FIELDS = ("scheme", "code", "label_ko", "label_en", "iri", "parent_code")


def active_codes(session: Session, scheme: str) -> set[str]:
    return set(
        session.execute(
            select(vocabulary_terms.c.code).where(
                vocabulary_terms.c.scheme == scheme, vocabulary_terms.c.active
            )
        ).scalars()
    )


def labels(session: Session, scheme: str, codes: list[str]) -> dict[str, dict[str, Any]]:
    if not codes:
        return {}
    found = session.execute(
        select(*(vocabulary_terms.c[f] for f in FIELDS)).where(
            vocabulary_terms.c.scheme == scheme, vocabulary_terms.c.code.in_(codes)
        )
    ).mappings()
    return {row["code"]: dict(row) for row in found}


def list_terms(session: Session, scheme: str) -> dict[str, Any]:
    found = session.execute(
        select(*(vocabulary_terms.c[f] for f in FIELDS))
        .where(vocabulary_terms.c.scheme == scheme, vocabulary_terms.c.active)
        .order_by(vocabulary_terms.c.parent_code.nulls_first(), vocabulary_terms.c.code)
    ).mappings()
    return {"items": [dict(row) for row in found]}


def create_term(session: Session, user: CurrentUser, scheme: str, body: VocabularyTermIn) -> dict[str, Any]:
    if not user.is_platform_admin:
        raise ApiError(ErrorCode.FORBIDDEN, "Only a PLATFORM_ADMIN can add vocabulary terms.")
    if body.parent_code is not None and body.parent_code not in active_codes(session, scheme):
        raise ApiError(
            ErrorCode.VALIDATION_FAILED,
            "Unknown parent term.",
            {"fields": [{"field": "parent_code", "reason": "VOCABULARY_TERM_UNKNOWN"}]},
        )
    values = {"scheme": scheme, **body.model_dump()}
    try:
        with session.begin_nested():
            session.execute(insert(vocabulary_terms).values(term_id=new_id(), **values))
    except IntegrityError as exc:
        raise ApiError(ErrorCode.CONFLICT, "This code already exists in the scheme.") from exc
    return {field: values.get(field) for field in FIELDS}
