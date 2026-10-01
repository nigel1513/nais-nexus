"""transferUserOrganization (Wave 1.5 spec §3.0b): end the current membership (kept as history), open a new one,
then point the Keycloak org_code attribute at the new organization before the transaction commits."""

from datetime import datetime
from uuid import UUID

from sqlalchemy import insert, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.modules.identity.keycloak_admin import KeycloakAdminPort, KeycloakAdminUnavailable
from api.modules.identity.members import membership_out, membership_select, validated_roles
from api.modules.identity.schemas import MembershipOut, TransferIn
from api.modules.identity.tables import CURRENT_MEMBERSHIP, memberships, organizations, users
from api.platform import clock, ports
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.events import EventActor
from api.platform.generated.error_codes import ErrorCode
from api.platform.generated.event_types import EventType
from api.platform.ids import new_id
from api.platform.outbox import outbox


def _keycloak() -> KeycloakAdminPort:
    try:
        return ports.get(KeycloakAdminPort)
    except ports.PortNotProvided as exc:
        raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Keycloak admin is not wired.") from exc


def _set_org_code(keycloak_sub: str, org_code: str) -> None:
    try:
        _keycloak().set_org_code(keycloak_sub, org_code)
    except KeycloakAdminUnavailable as exc:
        raise ApiError(
            ErrorCode.DEPENDENCY_UNAVAILABLE, "Keycloak is unavailable; nothing was changed."
        ) from exc


def transfer_user(session: Session, actor: CurrentUser, user_id: UUID, body: TransferIn) -> MembershipOut:
    if not actor.is_platform_admin:
        raise ApiError(ErrorCode.FORBIDDEN, "Only a PLATFORM_ADMIN can move users between organizations.")
    # Row lock serializes concurrent transfers of the same user (also covers users with no current membership).
    account = session.execute(
        select(users.c.user_id, users.c.keycloak_sub).where(users.c.user_id == user_id).with_for_update()
    ).first()
    if account is None:
        raise ApiError(ErrorCode.NOT_FOUND)
    target = session.execute(
        select(organizations.c.organization_id, organizations.c.code).where(
            organizations.c.organization_id == body.organization_id
        )
    ).first()
    if target is None:
        raise ApiError(
            ErrorCode.VALIDATION_FAILED,
            "Unknown organization.",
            {"fields": [{"field": "organization_id", "reason": "UNKNOWN_ORGANIZATION"}]},
        )
    roles = validated_roles(body.roles)
    current = session.execute(
        membership_select()
        .where(memberships.c.user_id == user_id, CURRENT_MEMBERSHIP)
        .with_for_update(of=memberships)
    ).first()
    if current is not None and current.organization_id == body.organization_id:
        _set_org_code(account.keycloak_sub, target.code)  # idempotent repair of the token claim
        return membership_out(current)

    now = clock.now()
    event_actor = EventActor.for_user(actor)
    if current is not None:
        session.execute(
            update(memberships)
            .where(memberships.c.user_id == user_id, CURRENT_MEMBERSHIP)
            .values(status="DISABLED", roles=[], ended_at=now, updated_at=now, updated_by=actor.user_id)
        )
        outbox.write(
            session,
            EventType.IDENTITY_MEMBERSHIP_CHANGED_V1,
            {
                "user_id": str(user_id),
                "organization_id": str(current.organization_id),
                "previous_roles": sorted(current.roles),
                "roles": [],
                "previous_status": current.status,
                "status": "DISABLED",
            },
            event_actor,
        )
    try:
        _open_membership(session, actor, user_id, body, roles, now)
    except IntegrityError as exc:  # uq_memberships_current: a concurrent request opened a membership first
        raise ApiError(ErrorCode.CONFLICT, "The user's membership changed concurrently; retry.") from exc
    outbox.write(
        session,
        EventType.IDENTITY_MEMBERSHIP_CHANGED_V1,
        {
            "user_id": str(user_id),
            "organization_id": str(body.organization_id),
            "previous_roles": [],
            "roles": roles,
            "previous_status": "DISABLED",
            "status": "ACTIVE",
        },
        event_actor,
    )
    session.flush()
    _set_org_code(
        account.keycloak_sub, target.code
    )  # last: a failure raises and the request transaction rolls back
    row = session.execute(
        membership_select().where(memberships.c.user_id == user_id, CURRENT_MEMBERSHIP)
    ).one()
    return membership_out(row)


def _open_membership(
    session: Session, actor: CurrentUser, user_id: UUID, body: TransferIn, roles: list[str], now: datetime
) -> None:
    session.execute(
        insert(memberships).values(
            membership_id=new_id(),
            user_id=user_id,
            organization_id=body.organization_id,
            roles=roles,
            status="ACTIVE",
            started_at=now,
            created_at=now,
            updated_at=now,
            updated_by=actor.user_id,
        )
    )
    session.flush()
