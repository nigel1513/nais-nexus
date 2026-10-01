"""HTTP surface (M05 §6): listReadinessProfiles, startReadinessValidation, getReadiness."""

import logging
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Response
from pydantic import BaseModel, ConfigDict, Field

from api.modules.readiness.catalog_port import CatalogQueryPort, VersionView
from api.modules.readiness.profile_registry import PROFILE_ORDER, PROFILES
from api.modules.readiness.service import (
    RequestNotSettled,
    latest_per_profile,
    load_checks,
    request_validation,
    to_api,
)
from api.platform import ports
from api.platform.auth import CurrentUser, CurrentUserDep
from api.platform.context import correlation_id
from api.platform.db import SessionDep
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode

logger = logging.getLogger("nais.readiness")
router = APIRouter(tags=["readiness"])
_UNAVAILABLE = "Catalog is temporarily unavailable."


class StartValidationBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    profile_id: str = Field(max_length=64)


def _catalog() -> CatalogQueryPort:
    try:
        return ports.get(CatalogQueryPort)
    except ports.PortNotProvided as exc:
        raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Catalog module is not installed.") from exc


def _can_see_all_versions(user: CurrentUser, owner_organization_id: UUID) -> bool:
    """Mirror of M03 access.can_see_all_versions (cross-module import is not allowed, D-038)."""
    return (
        user.is_platform_admin
        or user.has_org_role(owner_organization_id, "DATA_STEWARD")
        or user.has_org_role(owner_organization_id, "ORG_ADMIN")
    )


def _visible_version(user: CurrentUser, version_id: UUID) -> VersionView:
    """404 for unknown or invisible (D-012: invisible looks like missing). Any catalog failure is a generic 503."""
    catalog = _catalog()
    try:
        version = catalog.get_version(version_id)
        visible = version is not None and catalog.is_visible(user, version.dataset_id)
    except Exception:
        logger.exception("catalog lookup failed")  # details stay in the log, never in the response
        raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, _UNAVAILABLE) from None
    if version is None or not visible:
        raise ApiError(ErrorCode.NOT_FOUND)
    return version


@router.get("/readiness-profiles")
def list_readiness_profiles(user: CurrentUserDep) -> dict[str, Any]:
    return {"items": [PROFILES[name].to_api() for name in PROFILE_ORDER]}


@router.post("/dataset-versions/{version_id}/readiness-validations", status_code=202)
def start_readiness_validation(
    version_id: UUID, body: StartValidationBody, user: CurrentUserDep, session: SessionDep, response: Response
) -> dict[str, Any]:
    version = _visible_version(user, version_id)
    if not (user.is_platform_admin or user.has_org_role(version.owner_organization_id, "DATA_STEWARD")):
        raise ApiError(ErrorCode.FORBIDDEN)
    if version.status != "PUBLISHED":
        raise ApiError(ErrorCode.DATASET_VERSION_NOT_PUBLISHED)
    profile = PROFILES.get(body.profile_id)
    if profile is None:
        raise ApiError(ErrorCode.READINESS_PROFILE_UNKNOWN, details={"profile_id": body.profile_id})
    try:
        outcome = request_validation(
            session, version, profile, triggered_by="USER", requester=user, correlation_id=correlation_id()
        )
    except RequestNotSettled:
        logger.exception("validation request did not settle")
        raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Readiness is temporarily unavailable.") from None
    validation_id = outcome.row["validation_id"]
    if outcome.kind == "IN_PROGRESS":
        raise ApiError(
            ErrorCode.READINESS_VALIDATION_IN_PROGRESS, details={"validation_id": str(validation_id)}
        )
    if outcome.kind == "REUSED":
        response.status_code = 200
        return to_api(outcome.row, load_checks(session, [validation_id])[validation_id])
    return to_api(outcome.row, [])


@router.get("/dataset-versions/{version_id}/readiness")
def get_readiness(
    version_id: UUID, user: CurrentUserDep, session: SessionDep, profile_id: str | None = None
) -> dict[str, Any]:
    version = _visible_version(user, version_id)
    if version.status == "DRAFT":
        raise ApiError(ErrorCode.NOT_FOUND)
    if version.status == "WITHDRAWN" and not _can_see_all_versions(user, version.owner_organization_id):
        raise ApiError(ErrorCode.NOT_FOUND)  # same rule as M03 access.can_see_all_versions
    rows = latest_per_profile(session, version_id, profile_id)
    if profile_id is not None and not rows:
        raise ApiError(ErrorCode.READINESS_NOT_AVAILABLE)
    checks = load_checks(session, [r["validation_id"] for r in rows])
    return {"items": [to_api(r, checks[r["validation_id"]]) for r in rows]}
