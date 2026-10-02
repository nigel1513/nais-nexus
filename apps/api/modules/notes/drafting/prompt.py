"""The drafting prompt: a fixed system prompt and a user message of numbered activity lines plus the recorder's memo.

Input hygiene (the LLM runs on a GPU shared with another platform): an evidence row is reduced to exactly
(type, ref_id, label, at) before anything else sees it, unknown evidence types are dropped, labels are flattened to
one line and capped, and only type, label and Asia/Seoul time are written into the prompt (ref ids stay local, for
copying evidence onto the AI blocks). More than MAX_ITEMS rows are aggregated into one line per type with a count.
"""

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from api.platform.llm import ChatMessage

KST = timezone(timedelta(hours=9), "Asia/Seoul")
MAX_ITEMS = 60
MAX_LABEL_CHARS = 200
MAX_MEMO_CHARS = 4000
AGGREGATE_EXAMPLES = 3

# openapi NoteEvidenceType
EVIDENCE_TYPES = frozenset(
    {
        "INPUT_ADDED",
        "INPUT_VERSION_CHANGED",
        "RECIPE_SAVED",
        "RUN_SUCCEEDED",
        "RUN_FAILED",
        "OUTPUT_CREATED",
        "PUBLISH_REQUESTED",
        "DATASET_DOWNLOADED",
        "ACCESS_DECIDED",
    }
)

SYSTEM_PROMPT = """너는 국가연구개발 연구노트의 초안을 쓰는 도우미다.
규칙:
1) 주어진 활동 기록(번호 매긴 목록)만 근거로 쓴다. 기록에 없는 사실·수치·해석을 만들지 않는다.
2) 각 문장에 근거 번호를 evidence 배열로 단다. STEPS와 RESULTS 문장은 근거가 반드시 있어야 한다.
3) DIRECTION(방향·결정)과 NEXT(다음 할 일)는 연구자 메모가 있을 때만 쓴다. 없으면 빈 배열.
4) 한국어 평서문, 문장당 120자 이내, 섹션당 최대 6문장.
5) 아래 JSON 하나만 출력한다: {"sections":{"DIRECTION":[],"STEPS":[],"RESULTS":[],"NEXT":[]}} 각 원소는 {"text": "...", "evidence": [번호...]}."""

_WHITESPACE = re.compile(r"\s+")


@dataclass(frozen=True)
class EvidenceRow:
    """One activity of the day: labels only (openapi NoteEvidence)."""

    type: str
    ref_id: UUID
    label: str
    at: datetime


@dataclass(frozen=True)
class PromptItem:
    """One numbered line of the prompt and the evidence rows it stands for (one row, or a type aggregate)."""

    line: str
    rows: tuple[EvidenceRow, ...]


def one_line(text: str, limit: int) -> str:
    """Whitespace (newlines included) collapsed to single spaces, capped: a value can never start a new line."""
    flat = _WHITESPACE.sub(" ", text).strip()
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


def evidence_rows(raw: Iterable[Mapping[Any, Any]]) -> list[EvidenceRow]:
    """The allowed fields of stored evidence rows; any other key (payload, values, file contents...) is dropped here."""
    rows: list[EvidenceRow] = []
    for item in raw:
        kind = str(item["type"])
        if kind not in EVIDENCE_TYPES:
            continue
        at = item["at"]
        moment = datetime.fromisoformat(at) if isinstance(at, str) else at
        ref = item["ref_id"]
        rows.append(
            EvidenceRow(
                type=kind,
                ref_id=ref if isinstance(ref, UUID) else UUID(str(ref)),
                label=one_line(str(item["label"]), MAX_LABEL_CHARS),
                at=moment,
            )
        )
    return rows


def _clock(at: datetime) -> str:
    return at.astimezone(KST).strftime("%H:%M")


def prompt_items(rows: Sequence[EvidenceRow]) -> list[PromptItem]:
    """Numbered lines in time order: one per row, or (over MAX_ITEMS rows) one per type with a count, a time range
    and a few example labels."""
    ordered = sorted(rows, key=lambda r: (r.at, r.type, str(r.ref_id)))
    if len(ordered) <= MAX_ITEMS:
        return [PromptItem(f"[{r.type}] {r.label} ({_clock(r.at)})", (r,)) for r in ordered]
    groups: dict[str, list[EvidenceRow]] = {}
    for r in ordered:
        groups.setdefault(r.type, []).append(r)
    items: list[PromptItem] = []
    for kind, group in groups.items():  # first occurrence order = time order
        examples = ", ".join(dict.fromkeys(r.label for r in group[-AGGREGATE_EXAMPLES:]))
        line = f"[{kind}] {len(group)}건 ({_clock(group[0].at)}–{_clock(group[-1].at)}; 최근: {examples})"
        items.append(PromptItem(line, tuple(group)))
    return items


def build_messages(note_date: date, items: Sequence[PromptItem], memos: Sequence[str]) -> list[ChatMessage]:
    lines = [f"날짜: {note_date.isoformat()} (Asia/Seoul)", "", "활동 기록:"]
    lines += [f"{number}. {item.line}" for number, item in enumerate(items, start=1)] or ["(없음)"]
    lines.append("")
    memo_lines = [one_line(m, MAX_MEMO_CHARS) for m in memos if m.strip()]
    if memo_lines:
        lines.append("연구자 메모:")
        budget = MAX_MEMO_CHARS
        for memo in memo_lines:
            if budget <= 0:
                break
            lines.append(f"- {memo[:budget]}")
            budget -= len(memo)
    else:
        lines.append("연구자 메모: 없음")
    return [ChatMessage("system", SYSTEM_PROMPT), ChatMessage("user", "\n".join(lines))]
