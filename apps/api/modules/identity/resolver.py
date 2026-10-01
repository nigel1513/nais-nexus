"""M01 PrincipalResolver (spec §6): verified token claims -> CurrentUser.

Runs in its own short transaction (the platform auth dependency has no request session). Roles and status are read
on every call (no cache), so DISABLED takes effect on the next request.
"""

import hashlib
from collections.abc import Callable
from contextlib import AbstractContextManager
from typing import Any
from uuid import UUID

from sqlalchemy import Row, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.modules.identity.tables import memberships, organizations, user_sessions, users
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.db import session_scope
from api.platform.errors import ApiError
from api.platform.events import EventActor
from api.platform.generated.error_codes import ErrorCode
from api.platform.generated.event_types import EventType
from api.platform.ids import new_id
from api.platform.outbox import outbox

SessionFactory = Callable[[], AbstractContextManager[Session]]

MAX_SUB_LENGTH = 64
MAX_SESSION_ID_LENGTH = 64
MAX_EMAIL_LENGTH = 320
MAX_DISPLAY_NAME_LENGTH = 200


def session_id_for(claims: dict[str, Any]) -> str:
    """The token's sid; sha256(sid) when it does not fit the column; sha256("<sub>:<iat>") without a sid."""
    sid = claims.get("sid")
    if isinstance(sid, str) and sid:
        if len(sid) <= MAX_SESSION_ID_LENGTH:
            return sid
        return hashlib.sha256(sid.encode()).hexdigest()
    return hashlib.sha256(f"{claims['sub']}:{claims.get('iat')}".encode()).hexdigest()


def _display_name(claims: dict[str, Any], email: str) -> str:
    for key in ("name", "preferred_username"):
        value = claims.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()[:MAX_DISPLAY_NAME_LENGTH]
    return email.split("@", 1)[0][:MAX_DISPLAY_NAME_LENGTH]


def _user_actor(user_id: UUID, organization_id: UUID) -> EventActor:
    return EventActor(type="USER", user_id=user_id, organization_id=organization_id)


class IdentityPrincipalResolver:
    def __init__(self, sessions: SessionFactory = session_scope) -> None:
        self._sessions = sessions

    def resolve(self, claims: dict[str, Any], correlation_id: UUID) -> CurrentUser:
        sub = claims.get("sub")
        if not isinstance(sub, str) or not sub or len(sub) > MAX_SUB_LENGTH:
            raise ApiError(ErrorCode.UNAUTHENTICATED)
        with self._sessions() as session:
            organization_id = self._organization_id(session, claims.get("org_code"))
            row = self._load(session, sub)
            if row is None:
                self._provision(session, claims, sub, organization_id, correlation_id)
                row = self._load(session, sub)
                if row is None:
                    raise RuntimeError("provisioned user is not visible")
            self._check(row, organization_id)
            session_id = session_id_for(claims)
            self._record_session(session, row, session_id, correlation_id)
            return CurrentUser(
                user_id=row.user_id,
                organization_id=row.organization_id,
                org_roles=frozenset(row.roles),
                platform_roles=frozenset(row.platform_roles),
                session_id=session_id,
                display_name=row.display_name,
            )

    @staticmethod
    def _organization_id(session: Session, org_code: object) -> UUID:
        if isinstance(org_code, str) and org_code:
            found = session.execute(
                select(organizations.c.organization_id).where(organizations.c.code == org_code)
            ).first()
            if found is not None:
                return UUID(str(found.organization_id))
        raise ApiError(ErrorCode.ORGANIZATION_UNKNOWN)

    @staticmethod
    def _load(session: Session, sub: str) -> Row[Any] | None:
        return session.execute(
            select(
                users.c.user_id,
                users.c.status.label("user_status"),
                users.c.platform_roles,
                users.c.display_name,
                memberships.c.organization_id,
                memberships.c.roles,
                memberships.c.status.label("membership_status"),
            )
            .select_from(users.outerjoin(memberships, memberships.c.user_id == users.c.user_id))
            .where(users.c.keycloak_sub == sub)
        ).first()

    @staticmethod
    def _check(row: Row[Any], organization_id: UUID) -> None:
        if row.user_status != "ACTIVE":
            raise ApiError(ErrorCode.USER_DISABLED)
        if row.membership_status is None:
            raise ApiError(ErrorCode.ORGANIZATION_UNKNOWN)
        if row.membership_status != "ACTIVE":
            raise ApiError(ErrorCode.MEMBERSHIP_DISABLED)
        if row.organization_id != organization_id:
            raise ApiError(ErrorCode.ORGANIZATION_UNKNOWN, "Token org_code does not match your organization.")

    def _provision(
        self,
        session: Session,
        claims: dict[str, Any],
        sub: str,
        organization_id: UUID,
        correlation_id: UUID,
    ) -> None:
        raw_email = claims.get("email")
        if not isinstance(raw_email, str) or "@" not in raw_email:
            raise ApiError(ErrorCode.UNAUTHENTICATED, "Token has no usable email claim.")
        email = raw_email.strip().lower()
        if len(email) > MAX_EMAIL_LENGTH:
            raise ApiError(ErrorCode.UNAUTHENTICATED, "Token email claim is too long.")
        taken = session.execute(
            select(users.c.user_id).where(users.c.email == email, users.c.keycloak_sub != sub)
        ).first()
        if taken is not None:
            raise ApiError(ErrorCode.CONFLICT, "This email already belongs to another account.")
        display_name = _display_name(claims, email)
        user_id = new_id()
        try:
            with session.begin_nested():
                created = session.execute(
                    pg_insert(users)
                    .values(user_id=user_id, keycloak_sub=sub, email=email, display_name=display_name)
                    .on_conflict_do_nothing(index_elements=[users.c.keycloak_sub])
                    .returning(users.c.user_id)
                ).first()
        except IntegrityError as exc:  # email taken by a concurrent request with a different sub
            if self._load(session, sub) is None:
                raise ApiError(ErrorCode.CONFLICT, "This email already belongs to another account.") from exc
            return
        if created is None:  # a concurrent request provisioned this sub first
            return
        session.execute(
            pg_insert(memberships).values(
                membership_id=new_id(), user_id=user_id, organization_id=organization_id
            )
        )
        outbox.write(
            session,
            EventType.IDENTITY_USER_CREATED_V1,
            {
                "user_id": str(user_id),
                "organization_id": str(organization_id),
                "display_name": display_name,
                "email": email,
            },
            _user_actor(user_id, organization_id),
            correlation_id,
        )

    @staticmethod
    def _record_session(session: Session, row: Row[Any], session_id: str, correlation_id: UUID) -> None:
        inserted = session.execute(
            pg_insert(user_sessions)
            .values(session_id=session_id, user_id=row.user_id)
            .on_conflict_do_nothing(index_elements=[user_sessions.c.session_id])
            .returning(user_sessions.c.session_id)
        ).first()
        if inserted is None:
            return
        session.execute(update(users).where(users.c.user_id == row.user_id).values(last_login_at=clock.now()))
        outbox.write(
            session,
            EventType.IDENTITY_USER_LOGGED_IN_V1,
            {
                "user_id": str(row.user_id),
                "organization_id": str(row.organization_id),
                "session_id": session_id,
            },
            _user_actor(row.user_id, row.organization_id),
            correlation_id,
        )
