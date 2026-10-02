from typing import Any

from fastapi import APIRouter

from api.modules.catalog.schemas import SchemeIn, VocabularyTermIn
from api.modules.catalog.service import vocabulary as service
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep

router = APIRouter(tags=["catalog"])


@router.get("/vocabulary/{scheme}", operation_id="listVocabulary")
def list_vocabulary(scheme: SchemeIn, user: CurrentUserDep, session: SessionDep) -> dict[str, Any]:
    return service.list_terms(session, scheme)


@router.post("/vocabulary/{scheme}", operation_id="createVocabularyTerm", status_code=201)
def create_vocabulary_term(
    scheme: SchemeIn, body: VocabularyTermIn, user: CurrentUserDep, session: SessionDep
) -> dict[str, Any]:
    return service.create_term(session, user, scheme, body)
