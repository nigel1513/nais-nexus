"""Turn parsed sentences into AI blocks appended after the note's existing blocks.

Existing blocks are never changed (HUMAN or AI): the result holds only new rows. Each new block is origin=AI,
accepted=false and carries copies of the evidence rows its sentence cites (an aggregated line contributes at most
MAX_EVIDENCE_PER_BLOCK of its rows, newest first). A sentence is skipped when an AI block of the note (existing or
added just now) already has the same evidence set; evidence-free sentences (DIRECTION/NEXT) dedupe on section + text
instead, so a re-run of the same day does not pile up repeats.
"""

from collections.abc import Mapping, Sequence
from datetime import UTC
from typing import Any

from api.modules.notes.drafting.parse import DraftSentence
from api.modules.notes.drafting.prompt import EvidenceRow, PromptItem
from api.platform.ids import new_id

MAX_EVIDENCE_PER_BLOCK = 20

EvidenceKey = frozenset[tuple[str, str]]


def evidence_json(row: EvidenceRow) -> dict[str, Any]:
    """openapi NoteEvidence as stored in blocks.evidence."""
    at = row.at.astimezone(UTC).isoformat().replace("+00:00", "Z")
    return {"type": row.type, "ref_id": str(row.ref_id), "label": row.label, "at": at}


def _key(evidence: Sequence[Mapping[Any, Any]]) -> EvidenceKey:
    return frozenset((str(e["type"]), str(e["ref_id"])) for e in evidence)


def new_blocks(
    existing: Sequence[Mapping[Any, Any]], sentences: Sequence[DraftSentence], items: Sequence[PromptItem]
) -> list[dict[str, Any]]:
    seen_sets = {_key(b["evidence"]) for b in existing if b["origin"] == "AI" and b["evidence"]}
    seen_texts = {(b["section"], b["text"]) for b in existing if b["origin"] == "AI" and not b["evidence"]}
    position = max((int(b["position"]) for b in existing), default=-1) + 1
    rows: list[dict[str, Any]] = []
    for sentence in sentences:
        cited: list[EvidenceRow] = []
        for number in sentence.evidence:
            cited.extend(items[number - 1].rows[-MAX_EVIDENCE_PER_BLOCK:])
        evidence = [evidence_json(r) for r in dict.fromkeys(cited)][:MAX_EVIDENCE_PER_BLOCK]
        if evidence:
            key = _key(evidence)
            if key in seen_sets:
                continue
            seen_sets.add(key)
        else:
            if (sentence.section, sentence.text) in seen_texts:
                continue
            seen_texts.add((sentence.section, sentence.text))
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
