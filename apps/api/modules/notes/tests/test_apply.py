"""Applying a parsed draft (drafting/apply.py): AI blocks appended after the existing ones with accepted=false and
the referenced evidence copied; HUMAN blocks untouched; a sentence whose evidence set an AI block already has is
skipped."""

from datetime import UTC, datetime
from typing import Any

from api.modules.notes.drafting.apply import new_blocks
from api.modules.notes.drafting.parse import DraftSentence
from api.modules.notes.drafting.prompt import EvidenceRow, prompt_items
from api.platform.ids import new_id

T = datetime(2026, 10, 1, 5, 1, 20, tzinfo=UTC)
ROWS = [
    EvidenceRow("INPUT_ADDED", new_id(), "전극 열화 측정@v2", T),
    EvidenceRow("RUN_SUCCEEDED", new_id(), "고온 구간 평균 용량@3 · 182,340행 → 24행", T),
]
ITEMS = prompt_items(ROWS)


def stored(row: EvidenceRow) -> dict[str, Any]:
    return {"type": row.type, "ref_id": str(row.ref_id), "label": row.label, "at": "2026-10-01T05:01:20Z"}


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


def test_appends_ai_blocks_with_copied_evidence() -> None:
    human = block("HUMAN", "MEMO", "메모.", [], 0)
    rows = new_blocks(
        [human],
        [DraftSentence("STEPS", "입력을 추가하고 실행했다.", (1, 2)), DraftSentence("NEXT", "다음.", ())],
        ITEMS,
    )
    assert [(r["position"], r["section"], r["origin"], r["accepted"]) for r in rows] == [
        (1, "STEPS", "AI", False),
        (2, "NEXT", "AI", False),
    ]
    assert rows[0]["evidence"] == [stored(ROWS[0]), stored(ROWS[1])]
    assert rows[1]["evidence"] == []
    assert len({r["block_id"] for r in rows} | {human["block_id"]}) == 3


def test_skips_sentences_whose_evidence_set_an_ai_block_has() -> None:
    existing = [
        block("HUMAN", "STEPS", "사람이 쓴 같은 근거.", [stored(ROWS[0])], 0),
        block("AI", "STEPS", "이미 있는 초안.", [stored(ROWS[1]), stored(ROWS[0])], 1),
    ]
    rows = new_blocks(
        existing,
        [
            DraftSentence("RESULTS", "다르게 쓴 같은 근거.", (2, 1)),  # same set as the AI block: skipped
            DraftSentence("STEPS", "입력만.", (1,)),  # only a HUMAN block has this set: kept
            DraftSentence("STEPS", "입력만 다시.", (1,)),  # same set as the sentence just added: skipped
        ],
        ITEMS,
    )
    assert [r["text"] for r in rows] == ["입력만."]
    assert rows[0]["position"] == 2


def test_evidence_free_sentences_dedupe_by_section_and_text() -> None:
    existing = [block("AI", "DIRECTION", "고온 구간을 본다.", [], 0)]
    rows = new_blocks(
        existing,
        [
            DraftSentence("DIRECTION", "고온 구간을 본다.", ()),
            DraftSentence("DIRECTION", "저온 구간도 본다.", ()),
        ],
        ITEMS,
    )
    assert [r["text"] for r in rows] == ["저온 구간도 본다."]


def test_existing_blocks_are_never_returned_or_changed() -> None:
    existing = [block("HUMAN", "MEMO", "메모.", [], 0), block("AI", "STEPS", "초안.", [stored(ROWS[1])], 1)]
    before = [dict(b) for b in existing]
    rows = new_blocks(existing, [DraftSentence("STEPS", "새 문장.", (1,))], ITEMS)
    assert existing == before
    assert all(r["block_id"] not in {b["block_id"] for b in existing} for r in rows)


def test_aggregated_item_copies_a_bounded_number_of_rows() -> None:
    many = [EvidenceRow("RUN_SUCCEEDED", new_id(), f"run {i}", T) for i in range(70)]
    items = prompt_items(many)
    [row] = new_blocks([], [DraftSentence("STEPS", "많이 실행했다.", (1,))], items)
    assert 1 <= len(row["evidence"]) <= 20
