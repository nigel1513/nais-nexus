"""Contract views of stored notes (ResearchNote, ResearchNoteSummary) and the shared event payload."""

import logging
from collections.abc import Sequence
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.notes import repo
from api.modules.notes.access import DRAFT, witness_snapshot
from api.modules.notes.deps import NotesDeps
from api.modules.notes.schemas import ResearchNote, ResearchNoteSummary

logger = logging.getLogger("nais.notes")


def project_name(deps: NotesDeps, project_id: UUID) -> str:
    summary = deps.projects.get_summary(project_id)
    return summary.name if summary is not None else ""


def evidence_view(items: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"type": e["type"], "ref_id": e["ref_id"], "label": e["label"], "at": e["at"]} for e in items]


def draft_source_count(deps: NotesDeps, note: RowMapping, viewer_id: UUID) -> int:
    """Notebooks the recorder saved in the note's project on its day (the drafting source); 0 for anyone else, and
    0 (logged) when the notebook source fails."""
    if viewer_id != note["recorder_id"]:
        return 0
    try:
        return deps.notebooks.count_notebooks(note["recorder_id"], note["project_id"], note["note_date"])
    except Exception as exc:  # display only: a failing notebook source must not break reading the note
        logger.warning("draft source count unavailable", extra={"error_type": type(exc).__name__})
        return 0


def note_view(
    session: Session, deps: NotesDeps, note: RowMapping, viewer_id: UUID, *, source_count: int | None = None
) -> ResearchNote:
    """The full note as `viewer_id` sees it. While DRAFT the witness fields mirror what a submit would snapshot now
    (display only; DRAFT is shown to its recorder only); otherwise they are the stored snapshot."""
    note_id = note["note_id"]
    blocks = repo.load_blocks(session, [note_id])[note_id]
    signatures = repo.load_signatures(session, [note_id])[note_id]
    names = deps.people.get_display_names([note["recorder_id"], *(s["signer_id"] for s in signatures)])
    if note["status"] == DRAFT:
        witness_required, witness_user_ids = witness_snapshot(
            session, deps, note["project_id"], note["recorder_id"]
        )
    else:
        witness_required, witness_user_ids = (
            bool(note["witness_required"]),
            list(note["witness_user_ids"] or []),
        )
    return ResearchNote.model_validate(
        {
            "note_id": note_id,
            "project_id": note["project_id"],
            "project_name": project_name(deps, note["project_id"]),
            "organization_id": note["organization_id"],
            "recorder_id": note["recorder_id"],
            "recorder_display_name": names.get(note["recorder_id"], ""),
            "note_date": note["note_date"],
            "version": note["version"],
            "previous_version_id": note["previous_version_id"],
            "status": note["status"],
            "revision": note["revision"],
            "blocks": [
                {
                    "block_id": b["block_id"],
                    "section": b["section"],
                    "text": b["text"],
                    "origin": b["origin"],
                    "accepted": b["accepted"],
                    "evidence": evidence_view(b["evidence"]),
                }
                for b in blocks
            ],
            "draft_status": note["draft_status"],
            "draft_error": note["draft_error"],
            "draft_source_count": source_count
            if source_count is not None
            else draft_source_count(deps, note, viewer_id),
            "signatures": [
                {
                    "signer_id": s["signer_id"],
                    "signer_display_name": names.get(s["signer_id"], ""),
                    "role": s["role"],
                    "signed_at": s["signed_at"],
                    "content_hash": s["content_hash"],
                }
                for s in signatures
            ],
            "witness_required": witness_required,
            "witness_user_ids": witness_user_ids,
            "content_hash": note["content_hash"],
            "chain_hash": note["chain_hash"],
            "submitted_at": note["submitted_at"],
            "rejected_reason": note["rejected_reason"],
            "created_at": note["created_at"],
            "updated_at": note["updated_at"],
        }
    )


def summary_views(session: Session, deps: NotesDeps, rows: Sequence[RowMapping]) -> list[ResearchNoteSummary]:
    counts = repo.block_counts(session, [r["note_id"] for r in rows])
    names = deps.people.get_display_names([r["recorder_id"] for r in rows])
    projects = {p: project_name(deps, p) for p in dict.fromkeys(r["project_id"] for r in rows)}
    views = []
    for r in rows:
        block_count, unaccepted = counts.get(r["note_id"], (0, 0))
        views.append(
            ResearchNoteSummary.model_validate(
                {
                    "note_id": r["note_id"],
                    "project_id": r["project_id"],
                    "project_name": projects[r["project_id"]],
                    "recorder_id": r["recorder_id"],
                    "recorder_display_name": names.get(r["recorder_id"], ""),
                    "note_date": r["note_date"],
                    "version": r["version"],
                    "status": r["status"],
                    "draft_status": r["draft_status"],
                    "block_count": block_count,
                    "unaccepted_ai_count": unaccepted,
                    "submitted_at": r["submitted_at"],
                    "updated_at": r["updated_at"],
                }
            )
        )
    return views


def event_payload(note: RowMapping, actor_id: UUID, at: datetime, **extra: Any) -> dict[str, Any]:
    """Fields every notes.note.*.v1 payload carries."""
    return {
        "project_id": str(note["project_id"]),
        "actor_id": str(actor_id),
        "occurred_at": at.isoformat(),
        "note_id": str(note["note_id"]),
        "note_date": note["note_date"].isoformat(),
        "version": note["version"],
        "recorder_id": str(note["recorder_id"]),
        "organization_id": str(note["organization_id"]),
        **extra,
    }
