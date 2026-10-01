"""Identity HTTP routes (openapi tag identity). Thin: rules live in directory.py / members.py."""

from fastapi import APIRouter

from api.modules.identity import directory
from api.modules.identity.schemas import MeOut
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep

router = APIRouter(tags=["identity"])


@router.get("/me", operation_id="getMe")
def get_me(user: CurrentUserDep, session: SessionDep) -> MeOut:
    return directory.get_me(session, user.user_id)
