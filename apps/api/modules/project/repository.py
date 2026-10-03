"""All SQL for the project schema (SQLAlchemy Core). No authorization here: see service.py."""

from collections.abc import Sequence
from datetime import date, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import RowMapping, and_, delete, func, insert, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from api.modules.project.tables import project_members as m
from api.modules.project.tables import project_organizations as o
from api.modules.project.tables import projects as p
from api.platform.ids import new_id

ACTIVE = "ACTIVE"
REMOVED = "REMOVED"
ARCHIVED = "ARCHIVED"
OWNER = "PROJECT_OWNER"


def insert_project(
    session: Session,
    *,
    project_id: UUID,
    name: str,
    description: str,
    visibility: str,
    lead_organization_id: UUID,
    keywords: list[str],
    start_date: date | None,
    end_date: date | None,
    created_by: UUID,
    now: datetime,
) -> None:
    session.execute(
        insert(p).values(
            project_id=project_id,
            name=name,
            description=description,
            visibility=visibility,
            status=ACTIVE,
            lead_organization_id=lead_organization_id,
            keywords=keywords,
            start_date=start_date,
            end_date=end_date,
            created_by=created_by,
            created_at=now,
            updated_at=now,
        )
    )


def get_project(session: Session, project_id: UUID, *, lock: bool = False) -> RowMapping | None:
    """lock=True takes FOR UPDATE on the project row. Callers lock the project before any member rows."""
    stmt = select(p).where(p.c.project_id == project_id)
    if lock:
        stmt = stmt.with_for_update()
    return session.execute(stmt).mappings().first()


def update_project(session: Session, project_id: UUID, values: dict[str, Any], *, now: datetime) -> None:
    session.execute(update(p).where(p.c.project_id == project_id).values(**values, updated_at=now))


def archive_project(session: Session, project_id: UUID, *, now: datetime) -> None:
    session.execute(
        update(p).where(p.c.project_id == project_id).values(status=ARCHIVED, archived_at=now, updated_at=now)
    )


def touch_project(session: Session, project_id: UUID, *, now: datetime) -> None:
    session.execute(update(p).where(p.c.project_id == project_id).values(updated_at=now))


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def list_projects(
    session: Session,
    *,
    user_id: UUID,
    scope: str,
    status: str | None,
    q: str | None,
    after: tuple[datetime, UUID] | None,
    limit: int,
) -> Sequence[RowMapping]:
    """scope=mine: caller's ACTIVE memberships (any project status). scope=discover: PUBLIC + ACTIVE projects.
    Ordered updated_at desc, project_id desc; returns up to limit + 1 rows for has_more."""
    stmt = select(p)
    if scope == "mine":
        stmt = stmt.join(
            m, and_(m.c.project_id == p.c.project_id, m.c.user_id == user_id, m.c.status == ACTIVE)
        )
    else:
        stmt = stmt.where(p.c.visibility == "PUBLIC", p.c.status == ACTIVE)
    if status is not None:
        stmt = stmt.where(p.c.status == status)
    if q:
        stmt = stmt.where(p.c.name.ilike(f"%{_escape_like(q)}%", escape="\\"))
    if after is not None:
        updated_at, project_id = after
        stmt = stmt.where(
            or_(p.c.updated_at < updated_at, and_(p.c.updated_at == updated_at, p.c.project_id < project_id))
        )
    stmt = stmt.order_by(p.c.updated_at.desc(), p.c.project_id.desc()).limit(limit + 1)
    return session.execute(stmt).mappings().all()


def member_role(session: Session, project_id: UUID, user_id: UUID) -> str | None:
    return session.execute(
        select(m.c.role).where(m.c.project_id == project_id, m.c.user_id == user_id, m.c.status == ACTIVE)
    ).scalar_one_or_none()


def active_member(session: Session, project_id: UUID, user_id: UUID) -> RowMapping | None:
    return (
        session.execute(
            select(m).where(m.c.project_id == project_id, m.c.user_id == user_id, m.c.status == ACTIVE)
        )
        .mappings()
        .first()
    )


def insert_member(
    session: Session,
    *,
    project_id: UUID,
    user_id: UUID,
    organization_id: UUID,
    role: str,
    added_by: UUID,
    now: datetime,
    project_member_id: UUID | None = None,
) -> RowMapping:
    return (
        session.execute(
            insert(m)
            .values(
                project_member_id=project_member_id or new_id(),
                project_id=project_id,
                user_id=user_id,
                organization_id=organization_id,
                role=role,
                status=ACTIVE,
                joined_at=now,
                added_by=added_by,
            )
            .returning(m)
        )
        .mappings()
        .one()
    )


def set_member_role(session: Session, project_member_id: UUID, role: str) -> RowMapping:
    return (
        session.execute(
            update(m)
            .where(m.c.project_member_id == project_member_id, m.c.status == ACTIVE)
            .values(role=role)
            .returning(m)
        )
        .mappings()
        .one()
    )


def remove_member(session: Session, project_member_id: UUID, *, removed_by: UUID, now: datetime) -> bool:
    """Soft-delete an ACTIVE member; False when no ACTIVE row matched (nothing was removed)."""
    result = session.execute(
        update(m)
        .where(m.c.project_member_id == project_member_id, m.c.status == ACTIVE)
        .values(status=REMOVED, removed_at=now, removed_by=removed_by)
    )
    return bool(result.rowcount)  # type: ignore[attr-defined]


def count_active_members(session: Session, project_id: UUID) -> int:
    return int(
        session.execute(
            select(func.count()).select_from(m).where(m.c.project_id == project_id, m.c.status == ACTIVE)
        ).scalar_one()
    )


def count_active_owners(session: Session, project_id: UUID) -> int:
    return int(
        session.execute(
            select(func.count())
            .select_from(m)
            .where(m.c.project_id == project_id, m.c.status == ACTIVE, m.c.role == OWNER)
        ).scalar_one()
    )


def list_active_members(session: Session, project_id: UUID) -> Sequence[RowMapping]:
    return (
        session.execute(
            select(m)
            .where(m.c.project_id == project_id, m.c.status == ACTIVE)
            .order_by(m.c.joined_at, m.c.project_member_id)
        )
        .mappings()
        .all()
    )


def member_counts(session: Session, project_ids: Sequence[UUID]) -> dict[UUID, int]:
    if not project_ids:
        return {}
    rows = session.execute(
        select(m.c.project_id, func.count())
        .where(m.c.project_id.in_(project_ids), m.c.status == ACTIVE)
        .group_by(m.c.project_id)
    ).all()
    return {project_id: int(count) for project_id, count in rows}


def roles_for_user(session: Session, project_ids: Sequence[UUID], user_id: UUID) -> dict[UUID, str]:
    if not project_ids:
        return {}
    rows = session.execute(
        select(m.c.project_id, m.c.role).where(
            m.c.project_id.in_(project_ids), m.c.user_id == user_id, m.c.status == ACTIVE
        )
    ).all()
    return {project_id: role for project_id, role in rows}


def add_org_member(session: Session, project_id: UUID, organization_id: UUID, *, lead: bool = False) -> None:
    """One more ACTIVE member from this organization; creates the LEAD/PARTNER row on first use."""
    stmt = pg_insert(o).values(
        project_id=project_id,
        organization_id=organization_id,
        role="LEAD" if lead else "PARTNER",
        active_member_count=1,
    )
    session.execute(
        stmt.on_conflict_do_update(
            index_elements=[o.c.project_id, o.c.organization_id],
            set_={"active_member_count": o.c.active_member_count + 1},
        )
    )


def drop_org_member(session: Session, project_id: UUID, organization_id: UUID) -> None:
    """One ACTIVE member fewer; a PARTNER row at 0 is deleted, the LEAD row always stays (M02 §4)."""
    key = and_(o.c.project_id == project_id, o.c.organization_id == organization_id)
    session.execute(
        update(o)
        .where(key, o.c.active_member_count > 0)
        .values(active_member_count=o.c.active_member_count - 1)
    )
    session.execute(delete(o).where(key, o.c.role == "PARTNER", o.c.active_member_count == 0))


def list_organizations(session: Session, project_id: UUID) -> Sequence[RowMapping]:
    return (
        session.execute(select(o).where(o.c.project_id == project_id).order_by(o.c.role, o.c.organization_id))
        .mappings()
        .all()
    )


def is_active_member(session: Session, project_id: UUID, user_id: UUID) -> bool:
    """ACTIVE membership in an ACTIVE project (ARCHIVED projects answer False, M02 §8)."""
    stmt = (
        select(m.c.project_member_id)
        .join(p, p.c.project_id == m.c.project_id)
        .where(
            m.c.project_id == project_id, m.c.user_id == user_id, m.c.status == ACTIVE, p.c.status == ACTIVE
        )
    )
    return session.execute(stmt).first() is not None


def project_ids_for_member(session: Session, user_id: UUID) -> list[UUID]:
    rows: Sequence[UUID] = (
        session.execute(
            select(m.c.project_id).where(m.c.user_id == user_id, m.c.status == ACTIVE).order_by(m.c.joined_at)
        )
        .scalars()
        .all()
    )
    return list(rows)


def public_projects_in_order(session: Session, project_ids: Sequence[UUID]) -> Sequence[RowMapping]:
    """The PUBLIC + ACTIVE projects among `project_ids`, in that order (a search ranking). An id the index still
    has but that is no longer public is dropped here: the database decides what is public."""
    if not project_ids:
        return []
    found = {
        row["project_id"]: row
        for row in session.execute(
            select(p).where(p.c.project_id.in_(project_ids), p.c.visibility == "PUBLIC", p.c.status == ACTIVE)
        ).mappings()
    }
    return [found[project_id] for project_id in project_ids if project_id in found]
