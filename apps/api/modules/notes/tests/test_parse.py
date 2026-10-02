"""LLM answer parsing (drafting/parse.py): shape validation, evidence index range, unsupported STEPS/RESULTS
sentences dropped, sentence and section limits."""

import json

import pytest

from api.modules.notes.drafting.parse import DraftSentence, parse_draft


def answer(**sections: list) -> dict:
    return {"sections": {"DIRECTION": [], "STEPS": [], "RESULTS": [], "NEXT": [], **sections}}


def test_valid_answer() -> None:
    parsed = parse_draft(
        answer(
            DIRECTION=[{"text": "고온 구간을 우선 본다.", "evidence": []}],
            STEPS=[{"text": "평균 용량 레시피를 실행했다.", "evidence": [1, 2]}],
            RESULTS=[{"text": "24행이 나왔다.", "evidence": [2]}],
            NEXT=[{"text": "저온 구간도 본다.", "evidence": [1]}],
        ),
        item_count=2,
        has_memo=True,
    )
    assert parsed == [
        DraftSentence("DIRECTION", "고온 구간을 우선 본다.", ()),
        DraftSentence("STEPS", "평균 용량 레시피를 실행했다.", (1, 2)),
        DraftSentence("RESULTS", "24행이 나왔다.", (2,)),
        DraftSentence("NEXT", "저온 구간도 본다.", (1,)),
    ]


def test_text_with_code_fence_and_extra_prose() -> None:
    body = json.dumps(answer(STEPS=[{"text": "실행했다.", "evidence": [1]}]), ensure_ascii=False)
    for raw in (f"```json\n{body}\n```", f"초안입니다:\n{body}\n이상입니다.", body):
        assert parse_draft(raw, item_count=1, has_memo=False) == [DraftSentence("STEPS", "실행했다.", (1,))]


@pytest.mark.parametrize(
    "raw",
    [
        "not json at all",
        "[1, 2]",
        {},
        {"sections": []},
        {"sections": {"STEPS": "실행했다."}},
        {"sections": {"STEPS": ["실행했다."]}},
        {"sections": {"STEPS": [{"evidence": [1]}]}},
        {"sections": {"STEPS": [{"text": 3, "evidence": [1]}]}},
        {"sections": {"STEPS": [{"text": "x", "evidence": "1"}]}},
    ],
)
def test_bad_shapes_raise_value_error(raw: object) -> None:
    with pytest.raises(ValueError):
        parse_draft(raw, item_count=3, has_memo=True)  # type: ignore[arg-type]


def test_out_of_range_indexes_are_dropped_and_unsupported_steps_results_too() -> None:
    parsed = parse_draft(
        answer(
            STEPS=[
                {"text": "근거 없는 단계.", "evidence": []},
                {"text": "범위 밖 근거만.", "evidence": [0, 4, -1, True, "x", 2.5]},
                {"text": "일부만 유효.", "evidence": [3, 9, 3, "2"]},
            ],
            RESULTS=[{"text": "결과 근거 없음.", "evidence": []}],
            DIRECTION=[{"text": "근거 없는 방향.", "evidence": [7]}],
        ),
        item_count=3,
        has_memo=True,
    )
    assert parsed == [
        DraftSentence("DIRECTION", "근거 없는 방향.", ()),
        DraftSentence("STEPS", "일부만 유효.", (2, 3)),
    ]


def test_direction_and_next_need_a_memo() -> None:
    parsed = parse_draft(
        answer(
            DIRECTION=[{"text": "방향.", "evidence": [1]}],
            NEXT=[{"text": "다음.", "evidence": []}],
            STEPS=[{"text": "단계.", "evidence": [1]}],
        ),
        item_count=1,
        has_memo=False,
    )
    assert parsed == [DraftSentence("STEPS", "단계.", (1,))]


def test_sentence_and_section_limits() -> None:
    long = "가" * 121
    parsed = parse_draft(
        answer(
            STEPS=[{"text": long, "evidence": [1]}]
            + [{"text": f"  단계 {i}.  ", "evidence": [1]} for i in range(8)]
            + [{"text": "   ", "evidence": [1]}],
        ),
        item_count=1,
        has_memo=False,
    )
    assert [s.text for s in parsed] == [f"단계 {i}." for i in range(6)]
    assert parse_draft(answer(STEPS=[{"text": "가" * 120, "evidence": [1]}]), item_count=1, has_memo=False)


def test_missing_and_unknown_sections_are_tolerated() -> None:
    parsed = parse_draft(
        {
            "sections": {
                "STEPS": [{"text": "단계.", "evidence": [1]}],
                "MEMO": [{"text": "x", "evidence": []}],
            }
        },
        item_count=1,
        has_memo=False,
    )
    assert parsed == [DraftSentence("STEPS", "단계.", (1,))]
