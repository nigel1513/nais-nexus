"""The web server's internal notes operations (D-049): getInternalNotebookActivity and draftInternalNoteSections.

Both read the researcher's notebooks of the day through the NotebookActivityPort (the shared Jupyter) and nothing else;
nothing is written. The draft goes through drafting/run.py, the same prompt, LLM call and answer policing as the
`notes.draft_note` job, with draftNote's error rules: LLM off -> 503 LLM_UNAVAILABLE, the notebook source failing ->
503 DEPENDENCY_UNAVAILABLE, no notebook that day -> 422 VALIDATION_FAILED reason NO_NOTEBOOK_ACTIVITY, and an
unreachable, truncated or twice unusable answer -> 503 LLM_UNAVAILABLE.
"""

import logging
from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID

from nais_contracts.api_models import InternalDraftSections, InternalNotebookActivity

from api.modules.notes.deps import NotesDeps
from api.modules.notes.drafting.apply import fresh_sentences
from api.modules.notes.drafting.run import UnusableAnswer, ask, prepare
from api.modules.notes.interfaces import NotebookActivity
from api.modules.notes.sections import SECTIONS
from api.modules.notes.service.drafting import NO_NOTEBOOK_ACTIVITY, NO_NOTEBOOK_MESSAGE
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.llm import LlmTruncated, LlmUnavailable

logger = logging.getLogger("nais.notes")


def _utc(at: datetime) -> str:
    return at.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _activity(deps: NotesDeps, user_id: UUID, project_id: UUID, day: date) -> list[NotebookActivity]:
    try:
        return deps.notebooks.list_notebook_activity(user_id, project_id, day)
    except Exception as exc:  # Jupyter down or refusing the token
        logger.warning(
            "internal notes: notebook source unavailable", extra={"error_type": type(exc).__name__}
        )
        raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "The notebook source is unavailable.") from exc


def notebook_activity(
    deps: NotesDeps, user_id: UUID, project_id: UUID, day: date, *, detail: bool = False
) -> InternalNotebookActivity:
    """From file listings (cell_count null) unless `detail`, which reads the notebooks (cell_count filled)."""
    rows: list[tuple[str, datetime, int | None]]
    if detail:
        activity = sorted(_activity(deps, user_id, project_id, day), key=lambda a: (a.saved_at, a.title))
        rows = [(a.title, a.saved_at, len(a.cells)) for a in activity]
    else:
        try:
            saves = deps.notebooks.list_notebook_saves(user_id, project_id, day)
        except Exception as exc:  # Jupyter down or refusing the token
            logger.warning(
                "internal notes: notebook source unavailable", extra={"error_type": type(exc).__name__}
            )
            raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "The notebook source is unavailable.") from exc
        rows = [(s.title, s.saved_at, None) for s in sorted(saves, key=lambda s: (s.saved_at, s.title))]
    return InternalNotebookActivity.model_validate(
        {
            "count": len(rows),
            "notebooks": [
                {"title": title, "saved_at": _utc(at), "cell_count": cells} for title, at, cells in rows
            ],
        }
    )


def draft_sections(deps: NotesDeps, user_id: UUID, project_id: UUID, day: date) -> InternalDraftSections:
    llm = deps.llm()
    if llm is None:
        raise ApiError(ErrorCode.LLM_UNAVAILABLE, "Drafting is unavailable: the local LLM is switched off.")
    activity = _activity(deps, user_id, project_id, day)
    if not activity:
        raise ApiError(ErrorCode.VALIDATION_FAILED, NO_NOTEBOOK_MESSAGE, {"reason": NO_NOTEBOOK_ACTIVITY})
    items, messages = prepare(day, activity)
    log = {"internal": True, "project_id": str(project_id)}
    try:
        sentences = ask(llm, messages, items, log)
    except (LlmUnavailable, LlmTruncated, UnusableAnswer) as exc:
        logger.warning("internal draft failed", extra=log | {"error_type": type(exc).__name__})
        raise ApiError(ErrorCode.LLM_UNAVAILABLE, "The local LLM could not draft the note.") from exc
    sections: dict[str, list[dict[str, Any]]] = {section: [] for section in SECTIONS}
    for sentence, evidence in fresh_sentences([], sentences, items):  # the job's in-draft dedupe and evidence
        sections[sentence.section].append(
            {"text": sentence.text, "evidence": [{"label": e["label"], "at": e["at"]} for e in evidence]}
        )
    return InternalDraftSections.model_validate({"sections": sections})
