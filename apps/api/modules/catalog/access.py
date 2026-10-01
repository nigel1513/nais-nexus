"""Who may see and change what (M03 §6, §9; D-011, D-012, D-013). Invisible -> 404, visible but not allowed -> 403."""

from collections.abc import Mapping
from typing import Any
from uuid import UUID

from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.catalog.domain import DATA_STEWARD, ORG_ADMIN
from api.modules.catalog.repo import load_dataset, load_version, must
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode


def is_steward(user: CurrentUser, owner_organization_id: UUID) -> bool:
    return user.has_org_role(owner_organization_id, DATA_STEWARD)


def can_see_all_versions(user: CurrentUser, owner_organization_id: UUID) -> bool:
    return (
        user.is_platform_admin
        or user.has_org_role(owner_organization_id, DATA_STEWARD)
        or user.has_org_role(owner_organization_id, ORG_ADMIN)
    )


def can_see_dataset(user: CurrentUser, ds: Mapping[Any, Any]) -> bool:
    """D-012 metadata visibility, evaluated on the DB row (same rule as the search filter, plus owner/admin
    access to WITHDRAWN datasets so the steward can reactivate them)."""
    if user.is_platform_admin or user.organization_id == ds["owner_organization_id"]:
        return True
    return ds["status"] == "ACTIVE" and ds["access_level"] != "INTERNAL" and bool(ds["has_published_version"])


def can_see_version(user: CurrentUser, ds: Mapping[Any, Any], version: Mapping[Any, Any]) -> bool:
    return can_see_dataset(user, ds) and (
        version["status"] == "PUBLISHED" or can_see_all_versions(user, ds["owner_organization_id"])
    )


def not_found(what: str = "Resource") -> ApiError:
    return ApiError(ErrorCode.NOT_FOUND, f"{what} not found.")


def visible_dataset(
    session: Session, user: CurrentUser, dataset_id: UUID, *, for_update: bool = False
) -> RowMapping:
    ds = load_dataset(session, dataset_id, for_update=for_update)
    if ds is None or not can_see_dataset(user, ds):
        raise not_found("Dataset")
    return ds


def require_steward(user: CurrentUser, ds: Mapping[Any, Any]) -> None:
    if not is_steward(user, ds["owner_organization_id"]):
        raise ApiError(ErrorCode.FORBIDDEN, "Only a DATA_STEWARD of the owner organization can do this.")


def steward_version(
    session: Session, user: CurrentUser, version_id: UUID, *, for_update: bool = False
) -> tuple[RowMapping, RowMapping]:
    version = load_version(session, version_id, for_update=for_update)
    if version is None:
        raise not_found("Dataset version")
    ds = must(load_dataset(session, version["dataset_id"]), "dataset")
    if not can_see_version(user, ds, version):
        raise not_found("Dataset version")
    require_steward(user, ds)
    return version, ds


def require_draft(version: Mapping[Any, Any]) -> None:
    if version["status"] != "DRAFT":
        raise ApiError(
            ErrorCode.DATASET_VERSION_IMMUTABLE,
            f"Dataset version is {version['status']} and cannot be modified.",
        )
