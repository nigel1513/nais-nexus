"""Identity HTTP routes (openapi tag identity). Thin: rules live in directory.py / members.py."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query

from api.modules.identity import directory
from api.modules.identity.public import IdentityPublicProfile, OrganizationSummary
from api.modules.identity.schemas import MeOut, OrganizationOut
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep
from api.platform.pagination import Page, PageParams, page_params

router = APIRouter(tags=["identity"])
Paging = Annotated[PageParams, Depends(page_params)]


@router.get("/me", operation_id="getMe")
def get_me(user: CurrentUserDep, session: SessionDep) -> MeOut:
    return directory.get_me(session, user.user_id)


@router.get("/users", operation_id="listUsers")
def list_users(
    user: CurrentUserDep,
    session: SessionDep,
    paging: Paging,
    q: Annotated[str | None, Query(min_length=2, max_length=200)] = None,
    organization_id: UUID | None = None,
) -> Page[IdentityPublicProfile]:
    return directory.search_users(session, q=q, organization_id=organization_id, params=paging)


@router.get("/organizations", operation_id="listOrganizations")
def list_organizations(
    user: CurrentUserDep, session: SessionDep, paging: Paging
) -> Page[OrganizationSummary]:
    return directory.list_organizations(session, paging)


@router.get("/organizations/{organization_id}", operation_id="getOrganization")
def get_organization(organization_id: UUID, user: CurrentUserDep, session: SessionDep) -> OrganizationOut:
    return directory.get_organization(session, organization_id)
