"""LLM answer parsing (drafting/parse.py): the 7 template sections, evidence keys checked against the prompt,
PROCEDURE/RESULTS need evidence, OBJECTIVE/DISCUSSION/NEXT need a cited markdown cell, sentence and section limits."""

import json
import logging
from datetime import UTC, datetime

import pytest

from api.modules.notes.drafting.parse import DraftSentence, parse_draft
from api.modules.notes.drafting.prompt import EvidenceRow, PromptItem
from api.platform.ids import new_id

T = datetime(2026, 10, 1, 5, 1, 20, tzinfo=UTC)
REF = new_id()


def item(key: str, markdown: bool = False) -> PromptItem:
    return PromptItem(key, f"[{key}] ...", EvidenceRow("NOTEBOOK", REF, f"분석 · 셀 {key}", T), markdown)


# notebook 1: a markdown cell 1.1 and code cells 1.2, 1.3
ITEMS = [item("1"), item("1.1", markdown=True), item("1.2"), item("1.3")]


def answer(**sections: list) -> dict:
    empty = ("OBJECTIVE", "METHOD", "PROCEDURE", "RESULTS", "DISCUSSION", "NEXT", "REFERENCES")
    return {name: [] for name in empty} | sections


def test_valid_answer_in_template_order() -> None:
    parsed = parse_draft(
        answer(
            REFERENCES=[{"text": "고온 구간 용량 분석 노트북.", "evidence": ["1"]}],
            OBJECTIVE=[{"text": "고온 구간 용량 감소를 확인한다.", "evidence": ["1.1"]}],
            METHOD=[{"text": "pandas로 충방전 데이터를 읽었다.", "evidence": []}],
            PROCEDURE=[{"text": "데이터를 불러와 평균을 계산했다.", "evidence": ["1.2", "1.3"]}],
            RESULTS=[{"text": "그래프 출력이 생성되었다.", "evidence": ["1.3"]}],
            DISCUSSION=[{"text": "저온 구간은 따로 볼 필요가 있다.", "evidence": ["1.1", "1.2"]}],
            NEXT=[{"text": "저온 구간을 분석한다.", "evidence": ["1.1"]}],
        ),
        ITEMS,
    )
    assert parsed == [
        DraftSentence("OBJECTIVE", "고온 구간 용량 감소를 확인한다.", ("1.1",)),
        DraftSentence("METHOD", "pandas로 충방전 데이터를 읽었다.", ()),
        DraftSentence("PROCEDURE", "데이터를 불러와 평균을 계산했다.", ("1.2", "1.3")),
        DraftSentence("RESULTS", "그래프 출력이 생성되었다.", ("1.3",)),
        DraftSentence("DISCUSSION", "저온 구간은 따로 볼 필요가 있다.", ("1.1", "1.2")),
        DraftSentence("NEXT", "저온 구간을 분석한다.", ("1.1",)),
        DraftSentence("REFERENCES", "고온 구간 용량 분석 노트북.", ("1",)),
    ]


def test_sections_wrapper_code_fence_and_extra_prose_are_tolerated() -> None:
    body = json.dumps({"sections": answer(PROCEDURE=[{"text": "실행했다.", "evidence": ["1.2"]}])})
    for raw in (f"```json\n{body}\n```", f"초안입니다:\n{body}\n이상입니다.", body):
        assert parse_draft(raw, ITEMS) == [DraftSentence("PROCEDURE", "실행했다.", ("1.2",))]


@pytest.mark.parametrize(
    "raw",
    [
        "not json at all",
        "[1, 2]",
        {},
        {"sections": []},
        {"STEPS": [{"text": "x", "evidence": ["1"]}]},
        {"PROCEDURE": "실행했다."},
        {"PROCEDURE": ["실행했다."]},
        {"PROCEDURE": [{"evidence": ["1.2"]}]},
        {"PROCEDURE": [{"text": 3, "evidence": ["1.2"]}]},
        {"PROCEDURE": [{"text": "x", "evidence": "1.2"}]},
    ],
)
def test_bad_shapes_raise_value_error(raw: object) -> None:
    with pytest.raises(ValueError):
        parse_draft(raw, ITEMS)  # type: ignore[arg-type]


def test_unknown_keys_are_dropped_and_unsupported_procedure_results_too() -> None:
    parsed = parse_draft(
        answer(
            PROCEDURE=[
                {"text": "근거 없는 수행.", "evidence": []},
                {"text": "없는 근거만.", "evidence": ["0", "2", "1.9", True, 2.5, None]},
                {"text": "일부만 유효.", "evidence": ["1.3", "9", "1.3", 1, " 1.2 "]},
            ],
            RESULTS=[{"text": "결과 근거 없음.", "evidence": []}],
            METHOD=[{"text": "근거 없는 방법.", "evidence": ["7"]}],
        ),
        ITEMS,
    )
    assert parsed == [
        DraftSentence("METHOD", "근거 없는 방법.", ()),
        DraftSentence("PROCEDURE", "일부만 유효.", ("1", "1.2", "1.3")),
    ]


def test_objective_discussion_next_need_a_cited_markdown_cell() -> None:
    parsed = parse_draft(
        answer(
            OBJECTIVE=[{"text": "코드만 근거.", "evidence": ["1.2"]}, {"text": "근거 없음.", "evidence": []}],
            DISCUSSION=[{"text": "노트북 전체만.", "evidence": ["1"]}],
            NEXT=[{"text": "설명 셀 근거.", "evidence": ["1.1"]}],
        ),
        ITEMS,
    )
    assert parsed == [DraftSentence("NEXT", "설명 셀 근거.", ("1.1",))]


def test_sentence_and_section_limits() -> None:
    long = "가" * 121
    parsed = parse_draft(
        answer(
            PROCEDURE=[{"text": long, "evidence": ["1.2"]}]
            + [{"text": f"  단계 {i}.  ", "evidence": ["1.2"]} for i in range(8)]
            + [{"text": "   ", "evidence": ["1.2"]}],
        ),
        ITEMS,
    )
    assert [s.text for s in parsed] == [f"단계 {i}." for i in range(6)]
    assert parse_draft(answer(PROCEDURE=[{"text": "가" * 120, "evidence": ["1.2"]}]), ITEMS)


def test_missing_and_unknown_sections_are_tolerated() -> None:
    parsed = parse_draft(
        {"PROCEDURE": [{"text": "단계.", "evidence": ["1.2"]}], "MEMO": [{"text": "x", "evidence": []}]},
        ITEMS,
    )
    assert parsed == [DraftSentence("PROCEDURE", "단계.", ("1.2",))]


def test_dropped_evidence_keys_are_logged_as_a_count(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.INFO, logger="nais.notes"):
        parse_draft(
            answer(PROCEDURE=[{"text": "실행했다.", "evidence": ["1.2", "9.9", True, "SECRET"]}]), ITEMS
        )
    [record] = [r for r in caplog.records if r.getMessage() == "draft evidence keys dropped"]
    assert record.dropped_evidence == 3
    assert "SECRET" not in record.getMessage() and "9.9" not in record.getMessage()


def test_integer_keys_mean_notebook_headers_and_strings_stay_exact() -> None:
    parsed = parse_draft(
        answer(REFERENCES=[{"text": "분석 노트북.", "evidence": [1, "01", "1.20", "1.2"]}]), ITEMS
    )
    assert parsed == [DraftSentence("REFERENCES", "분석 노트북.", ("1", "1.2"))]
