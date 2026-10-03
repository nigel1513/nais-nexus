"""The drafting prompt: a fixed system prompt and a user message of numbered lines from the day's Jupyter notebooks.

Source: the notebooks the recorder saved in the note's project on the note's day (interfaces.NotebookActivityPort).
Workspace activity (the evidence table) is not sent to the model; it is only listed on screen.

Input hygiene (the LLM runs on a GPU shared with another platform): each notebook is reduced to exactly
(notebook_id, title, version_id, saved_at) and each cell to (type, source_head, output_kinds, output_count, has_error)
before anything else sees them, so no other attribute an implementation might carry (output values, text, images)
can reach the prompt. Every value is flattened to one line and capped. Lines:
- one header per notebook: `[n] 노트북 '제목' (저장 HH:MM)` (Asia/Seoul time),
- one line per cell: `[n.k] 코드|설명: source head` and, for code cells, ` / 출력: kinds N개, 오류 있음|없음`.
At most MAX_NOTEBOOKS notebooks (the latest saved ones, shown in save order), MAX_CELLS cells and MAX_LISTING_CHARS
characters of listing in all; when cells must be cut every notebook keeps its leading cells (both budgets are shared
out one cell per notebook per round) and the cut count is written.
"""

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from api.platform.llm import ChatMessage

KST = timezone(timedelta(hours=9), "Asia/Seoul")
MAX_NOTEBOOKS = 10
MAX_CELLS = 120
MAX_SOURCE_CHARS = 400
MAX_LISTING_CHARS = 20_000  # every notebook line in all (headers, cells, cut notices)
NOTICE_RESERVE = 40  # characters kept back per possible cut notice
MAX_TITLE_CHARS = 200
MAX_LABEL_CHARS = 200  # workspace evidence labels (handlers.py), shown on screen only
MAX_KIND_CHARS = 40
MAX_KINDS = 10
NOTEBOOK = "NOTEBOOK"  # openapi NoteEvidenceType

SYSTEM_PROMPT = """너는 국가연구개발 연구노트(표준 양식)의 초안을 쓰는 도우미다.
입력은 연구자가 오늘 저장한 Jupyter 노트북의 번호 매긴 목록이다. 셀은 앞부분과 출력 종류만 있고 출력 값은 없다.
규칙:
1) 주어진 노트북 목록만 근거로 쓴다. 노트북에 없는 사실·수치·해석을 만들지 않는다.
2) 각 문장에 근거 번호를 evidence 배열로 단다(셀은 "1.2", 노트북 전체는 "1"). PROCEDURE와 RESULTS 문장은 근거 번호가 반드시 있어야 한다.
3) OBJECTIVE(연구 목표), DISCUSSION(고찰·문제점), NEXT(향후 계획)는 설명 셀에 근거가 있을 때만 그 셀 번호를 달아 쓴다. 없으면 빈 배열.
4) METHOD(연구 방법·재료)는 노트북에 드러난 데이터·도구·방법만 쓴다. REFERENCES(참고 자료)는 사용한 노트북 제목 목록으로 쓴다.
5) 한국어 평서문, 문장당 120자 이내, 섹션당 최대 6문장.
6) 아래 7개 섹션 키의 JSON 하나만 출력한다: {"OBJECTIVE":[],"METHOD":[],"PROCEDURE":[],"RESULTS":[],"DISCUSSION":[],"NEXT":[],"REFERENCES":[]} 각 섹션 값은 배열이고 각 원소는 문장 하나다: {"text": "...", "evidence": ["1.2", ...]}. 여러 문장을 한 text에 합치지 않는다."""

_WHITESPACE = re.compile(r"\s+")


@dataclass(frozen=True)
class EvidenceRow:
    """openapi NoteEvidence copied onto an AI block."""

    type: str
    ref_id: UUID
    label: str
    at: datetime


@dataclass(frozen=True)
class Cell:
    markdown: bool
    source: str
    output_kinds: tuple[str, ...]
    output_count: int
    has_error: bool


@dataclass(frozen=True)
class Notebook:
    notebook_id: UUID
    title: str
    version_id: UUID | None
    saved_at: datetime
    cells: tuple[Cell, ...]


@dataclass(frozen=True)
class PromptItem:
    """One numbered line: key "n" (a notebook) or "n.k" (its k-th cell), the evidence it stands for, and whether it
    is a markdown (설명) cell."""

    key: str
    line: str
    evidence: EvidenceRow
    markdown: bool = False


@dataclass(frozen=True)
class PromptPlan:
    """The numbered items and every line of the source listing (items plus cut notices), in prompt order."""

    items: list[PromptItem]
    lines: list[str]


def one_line(text: str, limit: int) -> str:
    """Whitespace (newlines included) collapsed to single spaces, capped: a value can never start a new line."""
    flat = _WHITESPACE.sub(" ", text).strip()
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


def _uuid(value: Any) -> UUID:
    return value if isinstance(value, UUID) else UUID(str(value))


def notebooks(raw: Iterable[Any]) -> list[Notebook]:
    """The allowed fields of the port's answer; any other attribute (output values, texts...) is never read."""
    out: list[Notebook] = []
    for activity in raw:
        cells = tuple(
            Cell(
                markdown=str(cell.type) == "markdown",
                source=one_line(str(cell.source_head), MAX_SOURCE_CHARS),
                output_kinds=tuple(one_line(str(k), MAX_KIND_CHARS) for k in cell.output_kinds)[:MAX_KINDS],
                output_count=max(0, int(cell.output_count)),
                has_error=bool(cell.has_error),
            )
            for cell in activity.cells
        )
        version = activity.version_id
        out.append(
            Notebook(
                notebook_id=_uuid(activity.notebook_id),
                title=one_line(str(activity.title), MAX_TITLE_CHARS),
                version_id=_uuid(version) if version is not None else None,
                saved_at=activity.saved_at,
                cells=cells,
            )
        )
    return out


def _clock(at: datetime) -> str:
    return at.astimezone(KST).strftime("%H:%M")


def _shares(costs: Sequence[Sequence[int]], max_cells: int, max_chars: int) -> list[int]:
    """Cells kept per notebook: one cell per notebook per round (leading cells first) while both the cell budget and
    the character budget allow; a notebook whose next cell does not fit stops growing."""
    kept = [0] * len(costs)
    stopped = [False] * len(costs)
    while max_cells > 0:
        grew = False
        for i, cells in enumerate(costs):
            if stopped[i] or kept[i] >= len(cells) or max_cells == 0:
                continue
            cost = cells[kept[i]]
            if cost > max_chars:
                stopped[i] = True
                continue
            kept[i] += 1
            max_cells -= 1
            max_chars -= cost
            grew = True
        if not grew:
            break
    return kept


def _cell_line(cell: Cell) -> str:
    line = f"{'설명' if cell.markdown else '코드'}: {cell.source}"
    if not cell.markdown:
        kinds = ", ".join(cell.output_kinds) or "없음"
        line += f" / 출력: {kinds} {cell.output_count}개, 오류 {'있음' if cell.has_error else '없음'}"
    return line


def plan(source: Sequence[Notebook]) -> PromptPlan:
    ordered = sorted(source, key=lambda n: (n.saved_at, str(n.notebook_id)))
    dropped = max(0, len(ordered) - MAX_NOTEBOOKS)
    shown = ordered[dropped:]  # the latest saved ones
    headers = [
        f"[{n}] 노트북 '{nb.title}' (저장 {_clock(nb.saved_at)})" for n, nb in enumerate(shown, start=1)
    ]
    costs = [
        [len(f"[{n}.{k}] {_cell_line(cell)}") + 1 for k, cell in enumerate(nb.cells, start=1)]
        for n, nb in enumerate(shown, start=1)
    ]
    fixed = sum(len(h) + 1 for h in headers) + NOTICE_RESERVE * (len(shown) + 1)
    shares = _shares(costs, MAX_CELLS, MAX_LISTING_CHARS - fixed)
    items: list[PromptItem] = []
    lines: list[str] = []
    for n, (notebook, share) in enumerate(zip(shown, shares, strict=True), start=1):
        ref = notebook.version_id or notebook.notebook_id
        header = PromptItem(
            str(n),
            headers[n - 1],
            EvidenceRow(NOTEBOOK, ref, notebook.title, notebook.saved_at),
        )
        items.append(header)
        lines.append(header.line)
        for k, cell in enumerate(notebook.cells[:share], start=1):
            item = PromptItem(
                f"{n}.{k}",
                f"[{n}.{k}] {_cell_line(cell)}",
                EvidenceRow(NOTEBOOK, ref, f"{notebook.title} · 셀 {k}", notebook.saved_at),
                cell.markdown,
            )
            items.append(item)
            lines.append(item.line)
        cut = len(notebook.cells) - share
        if cut:
            lines.append(f"(노트북 {n}: 셀 {len(notebook.cells)}개 중 {cut}개 생략)")
    if dropped:
        lines.append(f"(먼저 저장한 노트북 {dropped}개 생략)")
    return PromptPlan(items, lines)


def build_messages(note_date: date, prompt: PromptPlan) -> list[ChatMessage]:
    lines = [f"날짜: {note_date.isoformat()} (Asia/Seoul)", "", "오늘 저장한 노트북:"]
    lines += prompt.lines or ["(없음)"]
    return [ChatMessage("system", SYSTEM_PROMPT), ChatMessage("user", "\n".join(lines))]
