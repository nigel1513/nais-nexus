"""Dataset versions (M03 §5.1, §6.6): DRAFT creation, listing and detail with the file manifest."""

from typing import Any
from uuid import UUID

from sqlalchemy import insert, select
from sqlalchemy.engine import RowMapping
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.modules.catalog.access import (
    can_see_all_versions,
    can_see_version,
    not_found,
    require_steward,
    visible_dataset,
)
from api.modules.catalog.repo import files_of_versions, load_dataset, load_version, must, readiness_overall
from api.modules.catalog.schemas import VersionCreateIn
from api.modules.catalog.tables import dataset_versions
from api.modules.catalog.views import version_view
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.ids import new_id


def _label_exists() -> ApiError:
    return ApiError(
        ErrorCode.DATASET_VERSION_LABEL_EXISTS, "This version label is already used in the dataset."
    )


def version_response(session: Session, version: RowMapping) -> dict[str, Any]:
    version_id = version["dataset_version_id"]
    files = files_of_versions(session, [version_id])[version_id]
    readiness = (
        readiness_overall(session, [version_id])[version_id] if version["status"] == "PUBLISHED" else None
    )
    return version_view(version, files, readiness)


def create_version(
    session: Session, user: CurrentUser, dataset_id: UUID, body: VersionCreateIn
) -> dict[str, Any]:
    ds = visible_dataset(session, user, dataset_id, for_update=True)
    require_steward(user, ds)
    if ds["status"] != "ACTIVE":
        raise ApiError(ErrorCode.CONFLICT, "WITHDRAWN datasets cannot get new versions.")
    duplicate = session.execute(
        select(dataset_versions.c.dataset_version_id).where(
            dataset_versions.c.dataset_id == dataset_id,
            dataset_versions.c.version_label == body.version_label,
        )
    ).first()
    if duplicate is not None:
        raise _label_exists()
    version_id = new_id()
    now = clock.now()
    try:
        with session.begin_nested():
            session.execute(
                insert(dataset_versions).values(
                    dataset_version_id=version_id,
                    dataset_id=dataset_id,
                    version_label=body.version_label,
                    status="DRAFT",
                    change_note=body.change_note,
                    created_by=user.user_id,
                    created_at=now,
                    updated_at=now,
                )
            )
    except IntegrityError as exc:
        raise _label_exists() from exc
    return version_response(session, must(load_version(session, version_id), "version"))


def list_versions(session: Session, user: CurrentUser, dataset_id: UUID) -> dict[str, Any]:
    ds = visible_dataset(session, user, dataset_id)
    stmt = select(dataset_versions).where(dataset_versions.c.dataset_id == dataset_id)
    if not can_see_all_versions(user, ds["owner_organization_id"]):
        stmt = stmt.where(dataset_versions.c.status == "PUBLISHED")
    versions = (
        session.execute(
            stmt.order_by(dataset_versions.c.created_at.desc(), dataset_versions.c.dataset_version_id.desc())
        )
        .mappings()
        .all()
    )
    ids = [v["dataset_version_id"] for v in versions]
    files = files_of_versions(session, ids)
    readiness = readiness_overall(
        session, [v["dataset_version_id"] for v in versions if v["status"] == "PUBLISHED"]
    )
    return {
        "items": [
            version_view(v, files[v["dataset_version_id"]], readiness.get(v["dataset_version_id"]))
            for v in versions
        ]
    }


def get_version(session: Session, user: CurrentUser, version_id: UUID) -> dict[str, Any]:
    version = load_version(session, version_id)
    if version is None:
        raise not_found("Dataset version")
    ds = must(load_dataset(session, version["dataset_id"]), "dataset")
    if not can_see_version(user, ds, version):
        raise not_found("Dataset version")
    return version_response(session, version)
