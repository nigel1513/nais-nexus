"""10_SEED_DATA §4 seed project (idempotent: fixed ids, skipped when the project exists)."""

from sqlalchemy.orm import Session

from api.modules.project import repository as repo
from api.modules.project.seed_data import (
    ORG_A,
    ORG_B,
    SEED_OWNER_MEMBER_ID,
    SEED_PARTNER_MEMBER_ID,
    SEED_PROJECT_ID,
    SEED_PROJECT_NAME,
    USERS_BY_KEY,
)
from api.platform import clock
from api.platform.events import EventActor
from api.platform.outbox import outbox


def seed(session: Session) -> None:
    if repo.get_project(session, SEED_PROJECT_ID) is not None:
        return
    owner = USERS_BY_KEY["a.researcher"]
    partner = USERS_BY_KEY["b.researcher"]
    now = clock.now()
    repo.insert_project(
        session,
        project_id=SEED_PROJECT_ID,
        name=SEED_PROJECT_NAME,
        description="Seed project shared by Institute A and Institute B (dev only).",
        visibility="PRIVATE",
        lead_organization_id=ORG_A,
        keywords=[],
        start_date=None,
        end_date=None,
        created_by=owner.user_id,
        now=now,
    )
    repo.insert_member(
        session,
        project_member_id=SEED_OWNER_MEMBER_ID,
        project_id=SEED_PROJECT_ID,
        user_id=owner.user_id,
        organization_id=ORG_A,
        role="PROJECT_OWNER",
        added_by=owner.user_id,
        now=now,
    )
    repo.add_org_member(session, SEED_PROJECT_ID, ORG_A, lead=True)
    repo.insert_member(
        session,
        project_member_id=SEED_PARTNER_MEMBER_ID,
        project_id=SEED_PROJECT_ID,
        user_id=partner.user_id,
        organization_id=ORG_B,
        role="RESEARCHER",
        added_by=owner.user_id,
        now=now,
    )
    repo.add_org_member(session, SEED_PROJECT_ID, ORG_B)
    actor = EventActor(type="USER", user_id=owner.user_id, organization_id=owner.organization_id)
    outbox.write(
        session,
        "project.created.v1",
        {
            "project_id": str(SEED_PROJECT_ID),
            "name": SEED_PROJECT_NAME,
            "lead_organization_id": str(ORG_A),
            "visibility": "PRIVATE",
            "owner_user_id": str(owner.user_id),
        },
        actor,
    )
    outbox.write(
        session,
        "project.member.added.v1",
        {
            "project_id": str(SEED_PROJECT_ID),
            "project_name": SEED_PROJECT_NAME,
            "user_id": str(partner.user_id),
            "organization_id": str(ORG_B),
            "role": "RESEARCHER",
            "added_by": str(owner.user_id),
        },
        actor,
    )
