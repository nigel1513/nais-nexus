"""Applying a parsed draft (drafting/apply.py): AI blocks appended after the existing ones with accepted=false and
NOTEBOOK evidence copied from the cited lines; HUMAN blocks untouched; a sentence whose evidence set an AI block
already has is skipped."""

from datetime import UTC, datetime
from typing import Any

from api.modules.notes.drafting.apply import new_blocks
from api.modules.notes.drafting.parse import DraftSentence
from api.modules.notes.drafting.prompt import notebooks, plan
from api.modules.notes.interfaces import NotebookActivity, NotebookCell
from api.platform.ids import new_id

T = datetime(2026, 10, 1, 5, 1, 20, tzinfo=UTC)
VERSION = new_id()
ITEMS = plan(
    notebooks(
        [
            NotebookActivity(
                new_id(),
                "고온 구간 용량 분석",
                VERSION,
                T,
                (
                    NotebookCell("markdown", "## 목표", (), 0, False),
                    NotebookCell("code", "df.mean()", ("execute_result",), 1, False),
                ),
            )
        ]
    )
).items


def stored(k: int | None) -> dict[str, Any]:
    label = "고온 구간 용량 분석" + (f" · 셀 {k}" if k else "")
    return {"type": "NOTEBOOK", "ref_id": str(VERSION), "label": label, "at": "2026-10-01T05:01:20Z"}


def block(
    origin: str, section: str, text: str, evidence: list[dict[str, Any]], position: int
) -> dict[str, Any]:
    return {
        "block_id": new_id(),
        "position": position,
        "section": section,
        "text": text,
        "origin": origin,
        "accepted": origin == "HUMAN",
        "evidence": evidence,
    }


def test_appends_ai_blocks_with_notebook_evidence() -> None:
    human = block("HUMAN", "RESULTS", "직접 쓴 결과.", [], 0)
    rows = new_blocks(
        [human],
        [
            DraftSentence("PROCEDURE", "평균을 계산했다.", ("1.1", "1.2")),
            DraftSentence("METHOD", "pandas를 썼다.", ()),
            DraftSentence("REFERENCES", "고온 구간 용량 분석.", ("1",)),
        ],
        ITEMS,
    )
    assert [(r["position"], r["section"], r["origin"], r["accepted"]) for r in rows] == [
        (1, "PROCEDURE", "AI", False),
        (2, "METHOD", "AI", False),
        (3, "REFERENCES", "AI", False),
    ]
    assert rows[0]["evidence"] == [stored(1), stored(2)]
    assert rows[1]["evidence"] == []
    assert rows[2]["evidence"] == [stored(None)]
    assert len({r["block_id"] for r in rows} | {human["block_id"]}) == 4


def test_skips_sentences_whose_section_and_evidence_set_an_ai_block_has() -> None:
    existing = [
        block("HUMAN", "PROCEDURE", "사람이 쓴 같은 근거.", [stored(1)], 0),
        block("AI", "PROCEDURE", "이미 있는 초안.", [stored(2), stored(1)], 1),
    ]
    rows = new_blocks(
        existing,
        [
            DraftSentence(
                "PROCEDURE", "다르게 쓴 같은 근거.", ("1.1", "1.2")
            ),  # same section and set as the AI block
            DraftSentence("RESULTS", "다른 섹션, 같은 근거.", ("1.1", "1.2")),  # another section: kept
            DraftSentence("PROCEDURE", "설명 셀만.", ("1.1",)),  # only a HUMAN block has this set: kept
            DraftSentence("PROCEDURE", "설명 셀만 다시.", ("1.1",)),  # same set as the sentence just added
        ],
        ITEMS,
    )
    assert [r["text"] for r in rows] == ["다른 섹션, 같은 근거.", "설명 셀만."]
    assert [r["position"] for r in rows] == [2, 3]


def test_evidence_free_sentences_dedupe_by_section_and_text() -> None:
    existing = [block("AI", "METHOD", "pandas를 썼다.", [], 0)]
    rows = new_blocks(
        existing,
        [DraftSentence("METHOD", "pandas를 썼다.", ()), DraftSentence("METHOD", "matplotlib을 썼다.", ())],
        ITEMS,
    )
    assert [r["text"] for r in rows] == ["matplotlib을 썼다."]


def test_existing_blocks_are_never_returned_or_changed() -> None:
    existing = [block("HUMAN", "RESULTS", "메모.", [], 0), block("AI", "PROCEDURE", "초안.", [stored(2)], 1)]
    before = [dict(b) for b in existing]
    rows = new_blocks(existing, [DraftSentence("PROCEDURE", "새 문장.", ("1.1",))], ITEMS)
    assert existing == before
    assert all(r["block_id"] not in {b["block_id"] for b in existing} for r in rows)
