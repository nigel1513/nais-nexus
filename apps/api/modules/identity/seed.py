"""Idempotent identity seed (upsert by fixed id). Events only for rows this run actually inserted."""

from uuid import UUID

from sqlalchemy import or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from api.modules.identity.seed_data import ORGANIZATIONS, ORGS_BY_CODE, USERS, SeedOrganization, SeedUser
from api.modules.identity.tables import memberships, organizations, users
from api.platform import clock
from api.platform.events import EventActor
from api.platform.generated.event_types import EventType
from api.platform.ids import new_id
from api.platform.outbox import outbox


def seed(session: Session) -> None:
    correlation_id = new_id()
    for org in ORGANIZATIONS:
        _seed_organization(session, org, correlation_id)
    for user in USERS:
        _seed_user(session, user, correlation_id)


def _seed_organization(session: Session, org: SeedOrganization, correlation_id: UUID) -> None:
    created = session.execute(
        pg_insert(organizations)
        .values(organization_id=org.organization_id, code=org.code, name=org.name, type=org.type)
        .on_conflict_do_nothing(index_elements=[organizations.c.organization_id])
        .returning(organizations.c.organization_id)
    ).first()
    if created is None:
        session.execute(
            update(organizations)
            .where(organizations.c.organization_id == org.organization_id)
            .values(code=org.code, name=org.name, type=org.type, updated_at=clock.now())
        )
        return
    outbox.write(
        session,
        EventType.IDENTITY_ORGANIZATION_CREATED_V1,
        {"organization_id": str(org.organization_id), "code": org.code, "name": org.name, "type": org.type},
        EventActor.system(),
        correlation_id,
    )


def _seed_user(session: Session, user: SeedUser, correlation_id: UUID) -> None:
    organization_id = ORGS_BY_CODE[user.org_code].organization_id
    clash = session.execute(
        select(users.c.user_id).where(
            or_(users.c.keycloak_sub == user.keycloak_sub, users.c.email == user.email),
            users.c.user_id != user.user_id,
        )
    ).first()
    if clash is not None:
        raise RuntimeError(
            f"seed user {user.email} conflicts with existing user {clash.user_id} "
            "(same Keycloak sub or email); remove that user before seeding"
        )
    created = session.execute(
        pg_insert(users)
        .values(
            user_id=user.user_id,
            keycloak_sub=user.keycloak_sub,
            email=user.email,
            display_name=user.display_name,
            platform_roles=list(user.platform_roles),
        )
        .on_conflict_do_nothing(index_elements=[users.c.user_id])
        .returning(users.c.user_id)
    ).first()
    if created is None:
        session.execute(
            update(users)
            .where(users.c.user_id == user.user_id)
            .values(
                email=user.email,
                display_name=user.display_name,
                platform_roles=list(user.platform_roles),
                status="ACTIVE",
                updated_at=clock.now(),
            )
        )
    roles = sorted(user.org_roles)
    session.execute(
        pg_insert(memberships)
        .values(
            membership_id=new_id(),
            user_id=user.user_id,
            organization_id=organization_id,
            roles=roles,
            status=user.membership_status,
        )
        .on_conflict_do_update(
            index_elements=[memberships.c.user_id],
            set_={
                "organization_id": organization_id,
                "roles": roles,
                "status": user.membership_status,
                "updated_at": clock.now(),
                "updated_by": None,
            },
        )
    )
    if created is not None:
        outbox.write(
            session,
            EventType.IDENTITY_USER_CREATED_V1,
            {
                "user_id": str(user.user_id),
                "organization_id": str(organization_id),
                "display_name": user.display_name,
                "email": user.email,
            },
            EventActor.system(),
            correlation_id,
        )
