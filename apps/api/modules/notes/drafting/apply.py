"""Turn parsed sentences into AI blocks appended after the note's existing blocks.

Existing blocks are never changed (HUMAN or AI): the result holds only new rows. Each new block is origin=AI,
accepted=false and carries the NOTEBOOK evidence of the prompt lines its sentence cites (at most
MAX_EVIDENCE_PER_BLOCK). A sentence is skipped when an AI block of the note (existing or added just now) in the same
section already has the same evidence set (one markdown cell may well ground a goal and a next step); evidence-free
sentences (METHOD, REFERENCES) dedupe on section + text instead, so a re-run of
the same day does not pile up repeats.
"""

from collections.abc import Mapping, Sequence
from datetime import UTC
from typing import Any

from api.modules.notes.drafting.parse import DraftSentence
from api.modules.notes.drafting.prompt import EvidenceRow, PromptItem
from api.platform.ids import new_id

MAX_EVIDENCE_PER_BLOCK = 20

EvidenceKey = tuple[str, frozenset[tuple[str, str, str]]]


def evidence_json(row: EvidenceRow) -> dict[str, Any]:
    """openapi NoteEvidence as stored in blocks.evidence."""
    at = row.at.astimezone(UTC).isoformat().replace("+00:00", "Z")
    return {"type": row.type, "ref_id": str(row.ref_id), "label": row.label, "at": at}


def _key(section: str, evidence: Sequence[Mapping[Any, Any]]) -> EvidenceKey:
    # Cells of one notebook version share its ref_id: the label (title · 셀 k) tells them apart.
    return str(section), frozenset((str(e["type"]), str(e["ref_id"]), str(e["label"])) for e in evidence)


def fresh_sentences(
    existing: Sequence[Mapping[Any, Any]], sentences: Sequence[DraftSentence], items: Sequence[PromptItem]
) -> list[tuple[DraftSentence, list[dict[str, Any]]]]:
    """The sentences worth adding, each with its evidence (evidence_json, distinct, capped): repeats of an AI block
    already in `existing` or added earlier in this draft are dropped (same section + evidence set, or same section +
    text when there is no evidence). Shared by the job (new_blocks) and draftInternalNoteSections (existing = [])."""
    by_key = {item.key: item for item in items}
    seen_sets = {_key(b["section"], b["evidence"]) for b in existing if b["origin"] == "AI" and b["evidence"]}
    seen_texts = {(b["section"], b["text"]) for b in existing if b["origin"] == "AI" and not b["evidence"]}
    out: list[tuple[DraftSentence, list[dict[str, Any]]]] = []
    for sentence in sentences:
        cited = [by_key[k].evidence for k in sentence.evidence]
        evidence = [evidence_json(r) for r in dict.fromkeys(cited)][:MAX_EVIDENCE_PER_BLOCK]
        if evidence:
            key = _key(sentence.section, evidence)
            if key in seen_sets:
                continue
            seen_sets.add(key)
        else:
            if (sentence.section, sentence.text) in seen_texts:
                continue
            seen_texts.add((sentence.section, sentence.text))
        out.append((sentence, evidence))
    return out


def new_blocks(
    existing: Sequence[Mapping[Any, Any]], sentences: Sequence[DraftSentence], items: Sequence[PromptItem]
) -> list[dict[str, Any]]:
    position = max((int(b["position"]) for b in existing), default=-1) + 1
    rows: list[dict[str, Any]] = []
    for sentence, evidence in fresh_sentences(existing, sentences, items):
        rows.append(
            {
                "block_id": new_id(),
                "position": position,
                "section": sentence.section,
                "text": sentence.text,
                "origin": "AI",
                "accepted": False,
                "evidence": evidence,
            }
        )
        position += 1
    return rows
