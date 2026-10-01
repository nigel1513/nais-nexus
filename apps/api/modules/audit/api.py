"""REST API (spec §6): audit-events (read-only). Visibility is a SQL predicate (visibility.audit_scope)."""

from datetime import datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from nais_contracts.api_models import AuditAction, ResourceType
from sqlalchemy import ColumnElement, DateTime, RowMapping, and_, func, literal, select, tuple_, update
from sqlalchemy.dialects.postgresql import UUID as PG_UUID

from api.modules.audit.tables import audit_events, notifications
from api.modules.audit.visibility import audit_scope
from api.platform import clock
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.pagination import PageParams, build_page, page_params

router = APIRouter()
PageDep = Annotated[PageParams, Depends(page_params)]


def _invalid_cursor() -> ApiError:
    return ApiError(
        ErrorCode.VALIDATION_FAILED,
        "Invalid pagination cursor.",
        {"fields": [{"field": "cursor", "reason": "INVALID_CURSOR"}]},
    )


def decode_time_cursor(values: list[Any] | None) -> tuple[datetime, UUID] | None:
    """Cursor = [iso timestamp with tz, uuid] of the last item (sort key desc)."""
    if values is None:
        return None
    try:
        if len(values) != 2:
            raise ValueError("cursor arity")
        at = datetime.fromisoformat(str(values[0]))
        key = UUID(str(values[1]))
    except ValueError as exc:
        raise _invalid_cursor() from exc
    if at.tzinfo is None:
        raise _invalid_cursor()
    return at, key


def before_cursor(time_col: Any, id_col: Any, cursor: tuple[datetime, UUID]) -> ColumnElement[bool]:
    at, key = cursor
    return tuple_(time_col, id_col) < tuple_(
        literal(at, DateTime(timezone=True)), literal(key, PG_UUID(as_uuid=True))
    )


def _s(value: UUID | None) -> str | None:
    return None if value is None else str(value)


def serialize_audit(r: RowMapping) -> dict[str, Any]:
    return {
        "audit_event_id": str(r["audit_event_id"]),
        "occurred_at": r["occurred_at"].isoformat(),
        "action": r["action"],
        "result": r["result"],
        "reason": r["reason"],
        "actor": {
            "type": r["actor_type"],
            "user_id": _s(r["actor_user_id"]),
            "display_name": r["actor_display_name"],
            "organization_id": _s(r["actor_organization_id"]),
        },
        "resource": {
            "type": r["resource_type"],
            "id": str(r["resource_id"]),
            "owner_organization_id": _s(r["resource_owner_organization_id"]),
        },
        "project_id": _s(r["project_id"]),
        "policy_version": r["policy_version"],
        "source_event_id": str(r["source_event_id"]),
        "source_event_type": r["source_event_type"],
        "trace_id": r["trace_id"],
        "details": r["details"],
    }


@router.get("/audit-events", tags=["audit"], operation_id="listAuditEvents")
def list_audit_events(
    user: CurrentUserDep,
    session: SessionDep,
    page: PageDep,
    action: Annotated[list[AuditAction] | None, Query()] = None,
    actor_user_id: UUID | None = None,
    organization_id: UUID | None = None,
    project_id: UUID | None = None,
    resource_type: ResourceType | None = None,
    resource_id: UUID | None = None,
    from_: Annotated[datetime | None, Query(alias="from")] = None,
    to: datetime | None = None,
) -> dict[str, Any]:
    t = audit_events.c
    conditions: list[ColumnElement[bool]] = [
        audit_scope(user, project_id=project_id, organization_id=organization_id)
    ]
    if action:
        conditions.append(t.action.in_([a.value for a in action]))
    if actor_user_id is not None:
        conditions.append(t.actor_user_id == actor_user_id)
    if organization_id is not None:
        conditions.append(
            (t.actor_organization_id == organization_id)
            | (t.resource_owner_organization_id == organization_id)
        )
    if project_id is not None:
        conditions.append(t.project_id == project_id)
    if resource_type is not None:
        conditions.append(t.resource_type == resource_type.value)
    if resource_id is not None:
        conditions.append(t.resource_id == resource_id)
    if from_ is not None:
        conditions.append(t.occurred_at >= from_)
    if to is not None:
        conditions.append(t.occurred_at < to)
    cursor = decode_time_cursor(page.cursor)
    if cursor is not None:
        conditions.append(before_cursor(t.occurred_at, t.audit_event_id, cursor))
    rows = (
        session.execute(
            select(audit_events)
            .where(and_(*conditions))
            .order_by(t.occurred_at.desc(), t.audit_event_id.desc())
            .limit(page.limit + 1)
        )
        .mappings()
        .all()
    )
    result = build_page(
        rows, page.limit, key=lambda r: [r["occurred_at"].isoformat(), str(r["audit_event_id"])]
    )
    return {"items": [serialize_audit(r) for r in result.items], "page": result.page.model_dump()}


def serialize_notification(r: RowMapping) -> dict[str, Any]:
    return {
        "notification_id": str(r["notification_id"]),
        "type": r["type"],
        "title": r["title"],
        "body": r["body"],
        "link": r["link"],
        "read": r["read_at"] is not None,
        "created_at": r["created_at"].isoformat(),
    }


@router.get("/notifications", tags=["notifications"], operation_id="listNotifications")
def list_notifications(
    user: CurrentUserDep, session: SessionDep, page: PageDep, unread_only: bool = False
) -> dict[str, Any]:
    n = notifications.c
    mine = n.recipient_user_id == user.user_id
    conditions: list[ColumnElement[bool]] = [mine]
    if unread_only:
        conditions.append(n.read_at.is_(None))
    cursor = decode_time_cursor(page.cursor)
    if cursor is not None:
        conditions.append(before_cursor(n.created_at, n.notification_id, cursor))
    rows = (
        session.execute(
            select(notifications)
            .where(and_(*conditions))
            .order_by(n.created_at.desc(), n.notification_id.desc())
            .limit(page.limit + 1)
        )
        .mappings()
        .all()
    )
    unread = session.execute(
        select(func.count()).select_from(notifications).where(mine, n.read_at.is_(None))
    ).scalar_one()
    result = build_page(
        rows, page.limit, key=lambda r: [r["created_at"].isoformat(), str(r["notification_id"])]
    )
    return {
        "items": [serialize_notification(r) for r in result.items],
        "page": result.page.model_dump(),
        "unread_count": int(unread),
    }


@router.post(
    "/notifications/read-all",
    tags=["notifications"],
    operation_id="markAllNotificationsRead",
    status_code=204,
)
def mark_all_notifications_read(user: CurrentUserDep, session: SessionDep) -> Response:
    n = notifications.c
    session.execute(
        update(notifications)
        .where(n.recipient_user_id == user.user_id, n.read_at.is_(None))
        .values(read_at=clock.now())
    )
    return Response(status_code=204)


@router.post(
    "/notifications/{notification_id}/read", tags=["notifications"], operation_id="markNotificationRead"
)
def mark_notification_read(
    notification_id: UUID, user: CurrentUserDep, session: SessionDep
) -> dict[str, Any]:
    n = notifications.c
    mine = and_(n.notification_id == notification_id, n.recipient_user_id == user.user_id)
    row = (
        session.execute(
            update(notifications)
            .where(mine, n.read_at.is_(None))
            .values(read_at=clock.now())
            .returning(notifications)
        )
        .mappings()
        .first()
    )
    if row is None:  # already read (unchanged) or not mine / missing (404, no existence leak)
        row = session.execute(select(notifications).where(mine)).mappings().first()
    if row is None:
        raise ApiError(ErrorCode.NOTIFICATION_NOT_FOUND)
    return serialize_notification(row)
