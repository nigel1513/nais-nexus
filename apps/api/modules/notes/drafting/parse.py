"""Parse and police the model's answer: {"sections": {"DIRECTION": [...], "STEPS": [...], "RESULTS": [...],
"NEXT": [...]}} with elements {"text": str, "evidence": [1-based line numbers]}.

ValueError = the answer is unusable (no JSON object, wrong shape): the job retries once. Anything salvageable is
salvaged instead: evidence numbers out of range are dropped, then STEPS/RESULTS sentences left without evidence are
dropped (rule 2), DIRECTION/NEXT are dropped when the recorder wrote no memo (rule 3), blank or over-long sentences are
dropped and each section keeps its first SECTION_LIMIT sentences (rule 4). Unknown sections are ignored.
"""

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

SECTIONS = ("DIRECTION", "STEPS", "RESULTS", "NEXT")
NEEDS_EVIDENCE = frozenset({"STEPS", "RESULTS"})
NEEDS_MEMO = frozenset({"DIRECTION", "NEXT"})
MAX_SENTENCE_CHARS = 120
SECTION_LIMIT = 6

_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


@dataclass(frozen=True)
class DraftSentence:
    section: str
    text: str
    evidence: tuple[int, ...]  # 1-based prompt line numbers, ascending, distinct


def _json_object(text: str) -> dict[str, Any]:
    """The first JSON object in the text (code fences and prose around it are tolerated)."""
    candidates = [m.group(1) for m in _FENCE.finditer(text)] + [text]
    decoder = json.JSONDecoder()
    for candidate in candidates:
        start = candidate.find("{")
        while start != -1:
            try:
                value, _ = decoder.raw_decode(candidate, start)
            except ValueError:
                start = candidate.find("{", start + 1)
                continue
            if isinstance(value, dict):
                return value
            start = candidate.find("{", start + 1)
    raise ValueError("no JSON object in the answer")


def _index(value: Any, item_count: int) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, str) and value.strip().isdigit():
        value = int(value.strip())
    if isinstance(value, int) and 1 <= value <= item_count:
        return value
    return None


def parse_draft(raw: Mapping[str, Any] | str, *, item_count: int, has_memo: bool) -> list[DraftSentence]:
    answer = _json_object(raw) if isinstance(raw, str) else raw
    if not isinstance(answer, Mapping):
        raise ValueError("the answer is not a JSON object")
    sections = answer.get("sections")
    if not isinstance(sections, Mapping):
        raise ValueError("sections must be an object")
    out: list[DraftSentence] = []
    for section in SECTIONS:
        elements = sections.get(section, [])
        if not isinstance(elements, list):
            raise ValueError(f"sections.{section} must be an array")
        kept: list[DraftSentence] = []
        for element in elements:
            if not isinstance(element, Mapping) or not isinstance(element.get("text"), str):
                raise ValueError(f"sections.{section} elements need a text")
            evidence = element.get("evidence", [])
            if not isinstance(evidence, list):
                raise ValueError(f"sections.{section} evidence must be an array")
            text = " ".join(element["text"].split())
            numbers = sorted({i for i in (_index(v, item_count) for v in evidence) if i is not None})
            if not text or len(text) > MAX_SENTENCE_CHARS:
                continue
            if section in NEEDS_EVIDENCE and not numbers:
                continue
            if section in NEEDS_MEMO and not has_memo:
                continue
            if len(kept) < SECTION_LIMIT:
                kept.append(DraftSentence(section, text, tuple(numbers)))
        out.extend(kept)
    return out
