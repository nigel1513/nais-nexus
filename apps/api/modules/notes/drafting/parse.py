"""Parse and police the model's answer: {"OBJECTIVE": [...], "METHOD": [...], ..., "REFERENCES": [...]} (the seven
template sections; a {"sections": {...}} wrapper is tolerated) with elements {"text": str, "evidence": [prompt keys
such as "1.2" or "1"]}.

ValueError = the answer is unusable (no JSON object, none of the sections, wrong shape): the job retries once.
Anything salvageable is salvaged instead: a section given as one element object instead of an array is read as a
one-element array and a bare string element as a sentence without evidence (EXAONE 3.5 answers so), keys written as
in the listing ("[1.2]") are read without the brackets, evidence keys the prompt does not have are dropped, then
PROCEDURE/RESULTS sentences left without evidence are dropped, OBJECTIVE/DISCUSSION/NEXT sentences that cite no
markdown (설명) cell are dropped, blank or over-long sentences are dropped and each section keeps its first SECTION_LIMIT sentences. Unknown
sections are ignored. Sentences come out in template order.
"""

import json
import logging
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from api.modules.notes.drafting.prompt import PromptItem
from api.modules.notes.sections import SECTIONS

logger = logging.getLogger("nais.notes")

NEEDS_EVIDENCE = frozenset({"PROCEDURE", "RESULTS"})
NEEDS_MARKDOWN = frozenset({"OBJECTIVE", "DISCUSSION", "NEXT"})
MAX_SENTENCE_CHARS = 120
SECTION_LIMIT = 6

_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


@dataclass(frozen=True)
class DraftSentence:
    section: str
    text: str
    evidence: tuple[str, ...]  # prompt item keys, in prompt order, distinct


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


def _key(value: Any) -> str | None:
    """A prompt key: a string as written ("1.2", "1"; surrounding blanks and one pair of brackets ignored), or an integer n meaning the
    notebook header "n". Anything else (bools, floats, objects) is invalid."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        key = value.strip()
        return key[1:-1].strip() if key.startswith("[") and key.endswith("]") else key
    return None


def _sections(answer: Any) -> Mapping[str, Any]:
    if not isinstance(answer, Mapping):
        raise ValueError("the answer is not a JSON object")
    if "sections" in answer:
        answer = answer["sections"]
        if not isinstance(answer, Mapping):
            raise ValueError("sections must be an object")
    if not any(section in answer for section in SECTIONS):
        raise ValueError("the answer has none of the template sections")
    return answer


def parse_draft(raw: Mapping[str, Any] | str, items: Sequence[PromptItem]) -> list[DraftSentence]:
    sections = _sections(_json_object(raw) if isinstance(raw, str) else raw)
    order = {item.key: index for index, item in enumerate(items)}
    markdown = {item.key for item in items if item.markdown}
    out: list[DraftSentence] = []
    dropped = 0
    for section in SECTIONS:
        elements = sections.get(section, [])
        if isinstance(elements, Mapping):
            elements = [elements]
        if not isinstance(elements, list):
            raise ValueError(f"{section} must be an array")
        kept: list[DraftSentence] = []
        for element in elements:
            if isinstance(element, str):  # a bare sentence: no evidence
                element = {"text": element, "evidence": []}
            if not isinstance(element, Mapping) or not isinstance(element.get("text"), str):
                raise ValueError(f"{section} elements need a text")
            evidence = element.get("evidence", [])
            if not isinstance(evidence, list):
                raise ValueError(f"{section} evidence must be an array")
            text = " ".join(element["text"].split())
            valid = [k for k in map(_key, evidence) if k in order]
            dropped += len(evidence) - len(valid)
            keys = sorted(set(valid), key=order.__getitem__)
            if not text or len(text) > MAX_SENTENCE_CHARS:
                continue
            if section in NEEDS_EVIDENCE and not keys:
                continue
            if section in NEEDS_MARKDOWN and not markdown.intersection(keys):
                continue
            if len(kept) < SECTION_LIMIT:
                kept.append(DraftSentence(section, text, tuple(keys)))
        out.extend(kept)
    if dropped:  # the count only: the answer may quote the prompt
        logger.info("draft evidence keys dropped", extra={"dropped_evidence": dropped})
    return out
