"""list/put dataset contributors (Wave 1.5 spec §3.2): replace-all, affiliation kept for unchanged pairs."""

from typing import Any
from uuid import UUID

from sqlalchemy import delete, insert, update
from sqlalchemy.orm import Session

from api.modules.catalog.access import require_steward, visible_dataset
from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.repo import enqueue_index
from api.modules.catalog.research import contributor_rows, people_block
from api.modules.catalog.schemas import ContributorsPutIn
from api.modules.catalog.tables import dataset_contributors, datasets
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.events import EventActor
from api.platform.generated.error_codes import ErrorCode
from api.platform.outbox import outbox


def list_contributors(
    session: Session, deps: CatalogDeps, user: CurrentUser, dataset_id: UUID
) -> dict[str, Any]:
    ds = visible_dataset(session, user, dataset_id)
    return {"items": people_block(session, deps, ds)["contributors"]}


def put_contributors(
    session: Session, deps: CatalogDeps, user: CurrentUser, dataset_id: UUID, body: ContributorsPutIn
) -> dict[str, Any]:
    ds = visible_dataset(session, user, dataset_id, for_update=True)
    require_steward(user, ds)
    wanted = [(c.user_id, c.role) for c in body.contributors]
    problems: list[dict[str, str]] = []
    if len(set(wanted)) != len(wanted):
        problems.append({"field": "contributors", "reason": "DUPLICATE"})
    existing = {(r["user_id"], r["role"]): r for r in contributor_rows(session, dataset_id)}
    new_ids = [uid for uid, role in wanted if (uid, role) not in existing]
    people = deps.organizations.get_people(new_ids) if new_ids else {}
    for index, (uid, role) in enumerate(wanted):
        if (uid, role) not in existing and (people.get(uid) is None or people[uid].status != "ACTIVE"):
            problems.append({"field": f"contributors[{index}].user_id", "reason": "PERSON_NOT_ELIGIBLE"})
    if problems:
        raise ApiError(ErrorCode.VALIDATION_FAILED, "Contributors are invalid.", {"fields": problems})
    if wanted == list(existing):  # same pairs in the same order
        return {"items": people_block(session, deps, ds)["contributors"]}
    session.execute(delete(dataset_contributors).where(dataset_contributors.c.dataset_id == dataset_id))
    for position, (uid, role) in enumerate(wanted):
        affiliation = (
            existing[(uid, role)]["affiliation_organization_id"]
            if (uid, role) in existing
            else people[uid].organization_id
        )
        session.execute(
            insert(dataset_contributors).values(
                dataset_id=dataset_id,
                user_id=uid,
                role=role,
                affiliation_organization_id=affiliation,
                position=position,
            )
        )
    session.execute(
        update(datasets).where(datasets.c.dataset_id == dataset_id).values(updated_at=clock.now())
    )
    outbox.write(
        session,
        "catalog.dataset.metadata_changed.v1",
        {
            "dataset_id": str(dataset_id),
            "owner_organization_id": str(ds["owner_organization_id"]),
            "changed_fields": ["contributors"],
        },
        EventActor.for_user(user),
    )
    enqueue_index(session, dataset_id)
    return {"items": people_block(session, deps, ds)["contributors"]}
