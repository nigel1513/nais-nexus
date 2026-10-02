"""SQL for notes tables (Core). Callers own the transaction."""

from collections.abc import Sequence
from datetime import date, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import Select, and_, delete, func, insert, or_, select, tuple_, update
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.notes.tables import blocks, chains, evidence, notes, settings, signatures

ListKey = tuple[date, UUID]  # (note_date, note_id), newest first


# ---------------------------------------------------------------- notes


def load_note(session: Session, note_id: UUID, *, for_update: bool = False) -> RowMapping | None:
    stmt = select(notes).where(notes.c.note_id == note_id)
    if for_update:
        stmt = stmt.with_for_update()
    return session.execute(stmt).mappings().first()


def load_exportable(session: Session, note_ids: Sequence[UUID], viewer_id: UUID) -> dict[UUID, RowMapping]:
    """Of the given notes, those the viewer may still export: their own (any status) or another recorder's
    SUBMITTED/SIGNED note. A note rejected back to DRAFT since it was selected is never loaded."""
    if not note_ids:
        return {}
    stmt = select(notes).where(
        notes.c.note_id.in_(note_ids),
        or_(notes.c.recorder_id == viewer_id, notes.c.status.in_(("SUBMITTED", "SIGNED"))),
    )
    return {r["note_id"]: r for r in session.execute(stmt).mappings()}


def latest_version(
    session: Session, project_id: UUID, recorder_id: UUID, note_date: date
) -> RowMapping | None:
    stmt = (
        select(notes)
        .where(
            notes.c.project_id == project_id,
            notes.c.recorder_id == recorder_id,
            notes.c.note_date == note_date,
        )
        .order_by(notes.c.version.desc())
        .limit(1)
    )
    return session.execute(stmt).mappings().first()


def insert_note(session: Session, **values: Any) -> RowMapping | None:
    """None when (project, recorder, day, version) already exists (a concurrent create won)."""
    stmt = (
        pg_insert(notes)
        .values(**values)
        .on_conflict_do_nothing(constraint="uq_notes_recorder_day_version")
        .returning(*notes.c)
    )
    return session.execute(stmt).mappings().first()


def update_note(session: Session, note_id: UUID, **values: Any) -> RowMapping:
    stmt = update(notes).where(notes.c.note_id == note_id).values(**values).returning(*notes.c)
    return session.execute(stmt).mappings().one()


def delete_note(session: Session, note_id: UUID) -> None:
    """Children first: the guard triggers allow it only while the note is DRAFT."""
    session.execute(delete(signatures).where(signatures.c.note_id == note_id))
    session.execute(delete(blocks).where(blocks.c.note_id == note_id))
    session.execute(delete(notes).where(notes.c.note_id == note_id))


# ---------------------------------------------------------------- blocks and signatures


def load_blocks(session: Session, note_ids: Sequence[UUID]) -> dict[UUID, list[RowMapping]]:
    out: dict[UUID, list[RowMapping]] = {note_id: [] for note_id in note_ids}
    if not note_ids:
        return out
    stmt = select(blocks).where(blocks.c.note_id.in_(note_ids)).order_by(blocks.c.note_id, blocks.c.position)
    for row in session.execute(stmt).mappings():
        out[row["note_id"]].append(row)
    return out


def replace_blocks(session: Session, note_id: UUID, rows: Sequence[dict[str, Any]]) -> None:
    session.execute(delete(blocks).where(blocks.c.note_id == note_id))
    if rows:
        session.execute(insert(blocks), [dict(row, note_id=note_id) for row in rows])


def load_signatures(session: Session, note_ids: Sequence[UUID]) -> dict[UUID, list[RowMapping]]:
    out: dict[UUID, list[RowMapping]] = {note_id: [] for note_id in note_ids}
    if not note_ids:
        return out
    stmt = (
        select(signatures)
        .where(signatures.c.note_id.in_(note_ids))
        .order_by(signatures.c.note_id, signatures.c.signed_at, signatures.c.role.desc())
    )
    for row in session.execute(stmt).mappings():
        out[row["note_id"]].append(row)
    return out


def insert_signature(session: Session, **values: Any) -> None:
    session.execute(insert(signatures).values(**values))


def delete_signatures(session: Session, note_id: UUID) -> None:
    session.execute(delete(signatures).where(signatures.c.note_id == note_id))


def block_counts(session: Session, note_ids: Sequence[UUID]) -> dict[UUID, tuple[int, int]]:
    """note_id -> (blocks, unaccepted AI blocks)."""
    if not note_ids:
        return {}
    unaccepted = func.count().filter(and_(blocks.c.origin == "AI", blocks.c.accepted.is_(False)))
    stmt = (
        select(blocks.c.note_id, func.count(), unaccepted)
        .where(blocks.c.note_id.in_(note_ids))
        .group_by(blocks.c.note_id)
    )
    return {row[0]: (row[1], row[2]) for row in session.execute(stmt)}


# ---------------------------------------------------------------- settings


def load_settings(session: Session, project_id: UUID) -> RowMapping | None:
    return session.execute(select(settings).where(settings.c.project_id == project_id)).mappings().first()


def upsert_settings(session: Session, project_id: UUID, **values: Any) -> RowMapping:
    stmt = (
        pg_insert(settings)
        .values(project_id=project_id, **values)
        .on_conflict_do_update(index_elements=[settings.c.project_id], set_=values)
        .returning(*settings.c)
    )
    return session.execute(stmt).mappings().one()


# ---------------------------------------------------------------- chains


def lock_chain(session: Session, project_id: UUID, organization_id: UUID) -> RowMapping:
    """The chain head, created on first use, locked FOR UPDATE until the transaction ends: SIGNED transitions of one
    project x organization chain are serialized."""
    session.execute(
        pg_insert(chains)
        .values(project_id=project_id, organization_id=organization_id, last_seq=0, last_chain_hash=None)
        .on_conflict_do_nothing(index_elements=[chains.c.project_id, chains.c.organization_id])
    )
    stmt = (
        select(chains)
        .where(chains.c.project_id == project_id, chains.c.organization_id == organization_id)
        .with_for_update()
    )
    return session.execute(stmt).mappings().one()


def advance_chain(
    session: Session, project_id: UUID, organization_id: UUID, *, seq: int, chain_hash: str, at: datetime
) -> None:
    session.execute(
        update(chains)
        .where(chains.c.project_id == project_id, chains.c.organization_id == organization_id)
        .values(last_seq=seq, last_chain_hash=chain_hash, updated_at=at)
    )


def load_chain(session: Session, project_id: UUID, organization_id: UUID) -> RowMapping | None:
    stmt = select(chains).where(
        chains.c.project_id == project_id, chains.c.organization_id == organization_id
    )
    return session.execute(stmt).mappings().first()


def signed_chain(session: Session, project_id: UUID, organization_id: UUID) -> list[RowMapping]:
    """Every SIGNED note of the chain in chain order."""
    stmt = (
        select(notes)
        .where(
            notes.c.project_id == project_id,
            notes.c.organization_id == organization_id,
            notes.c.status == "SIGNED",
        )
        .order_by(notes.c.chain_seq, notes.c.note_id)
    )
    return list(session.execute(stmt).mappings())


# ---------------------------------------------------------------- lists


def _dated(stmt: Select[Any], date_from: date | None, date_to: date | None) -> Select[Any]:
    if date_from is not None:
        stmt = stmt.where(notes.c.note_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(notes.c.note_date <= date_to)
    return stmt


def list_recorder_notes(
    session: Session,
    recorder_id: UUID,
    *,
    project_id: UUID | None,
    statuses: Sequence[str] | None,
    date_from: date | None,
    date_to: date | None,
    after: ListKey | None,
    limit: int,
) -> list[RowMapping]:
    """The latest version per (project, day) of the recorder's notes, newest day first, then filtered by status."""
    latest = select(notes).where(notes.c.recorder_id == recorder_id)
    if project_id is not None:
        latest = latest.where(notes.c.project_id == project_id)
    latest = _dated(latest, date_from, date_to)
    latest_sq = (
        latest.ext(distinct_on(notes.c.project_id, notes.c.note_date))
        .order_by(notes.c.project_id, notes.c.note_date, notes.c.version.desc())
        .subquery()
    )
    stmt = select(latest_sq)
    if statuses:
        stmt = stmt.where(latest_sq.c.status.in_(statuses))
    if after is not None:
        stmt = stmt.where(tuple_(latest_sq.c.note_date, latest_sq.c.note_id) < tuple_(*after))
    stmt = stmt.order_by(latest_sq.c.note_date.desc(), latest_sq.c.note_id.desc()).limit(limit)
    return list(session.execute(stmt).mappings())


def list_witness_notes(
    session: Session,
    witness_id: UUID,
    *,
    project_ids: Sequence[UUID],
    statuses: Sequence[str],
    date_from: date | None,
    date_to: date | None,
    after: ListKey | None,
    limit: int,
) -> list[RowMapping]:
    """SUBMITTED/SIGNED notes whose witness snapshot names the user, in the given projects, newest day first."""
    if not project_ids or not statuses:
        return []
    stmt = select(notes).where(
        notes.c.status.in_(statuses),
        notes.c.witness_user_ids.contains([witness_id]),
        notes.c.project_id.in_(project_ids),
        notes.c.recorder_id != witness_id,
    )
    stmt = _dated(stmt, date_from, date_to)
    if after is not None:
        stmt = stmt.where(tuple_(notes.c.note_date, notes.c.note_id) < tuple_(*after))
    stmt = stmt.order_by(notes.c.note_date.desc(), notes.c.note_id.desc()).limit(limit)
    return list(session.execute(stmt).mappings())


def export_notes(
    session: Session,
    project_id: UUID,
    recorder_id: UUID,
    *,
    organization_id: UUID | None,
    date_from: date | None,
    date_to: date | None,
    limit: int,
) -> list[RowMapping]:
    """Every version of the recorder's own notes in the project, plus (organization_id given: the caller is that
    organization's ORG_ADMIN) other recorders' SUBMITTED/SIGNED notes of that organization. Oldest first."""
    scope = notes.c.recorder_id == recorder_id
    if organization_id is not None:
        scope = or_(
            scope,
            and_(notes.c.organization_id == organization_id, notes.c.status.in_(("SUBMITTED", "SIGNED"))),
        )
    stmt = _dated(select(notes).where(notes.c.project_id == project_id, scope), date_from, date_to)
    stmt = stmt.order_by(notes.c.note_date, notes.c.recorder_id, notes.c.version, notes.c.note_id).limit(
        limit
    )
    return list(session.execute(stmt).mappings())


# ---------------------------------------------------------------- evidence and drafting (Task 10)


def insert_evidence(session: Session, **values: Any) -> None:
    """At most one row per source event (unique source_event_id)."""
    session.execute(
        pg_insert(evidence)
        .values(**values)
        .on_conflict_do_nothing(index_elements=[evidence.c.source_event_id])
    )


def day_evidence(session: Session, project_id: UUID, actor_id: UUID, note_date: date) -> list[RowMapping]:
    stmt = (
        select(evidence.c.type, evidence.c.ref_id, evidence.c.label, evidence.c.at)
        .where(
            evidence.c.project_id == project_id,
            evidence.c.actor_id == actor_id,
            evidence.c.note_date == note_date,
        )
        .order_by(evidence.c.at, evidence.c.evidence_id)
    )
    return list(session.execute(stmt).mappings())


def day_recorders(session: Session, note_date: date) -> list[RowMapping]:
    """(project_id, actor_id, organization_id) for every researcher with evidence on the day; organization_id is the
    actor's organization recorded with their own events (None when only others' decisions name them)."""
    organization = func.max(evidence.c.payload["organization_id"].astext)
    stmt = (
        select(evidence.c.project_id, evidence.c.actor_id, organization.label("organization_id"))
        .where(evidence.c.note_date == note_date)
        .group_by(evidence.c.project_id, evidence.c.actor_id)
        .order_by(evidence.c.project_id, evidence.c.actor_id)
    )
    return list(session.execute(stmt).mappings())


def append_blocks(session: Session, note_id: UUID, rows: Sequence[dict[str, Any]]) -> None:
    if rows:
        session.execute(insert(blocks), [dict(row, note_id=note_id) for row in rows])
