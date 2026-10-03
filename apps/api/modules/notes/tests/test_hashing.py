"""Canonical JSON, content hash and the hash chain (pure functions, no database)."""

import hashlib
import json
import unicodedata
from datetime import UTC, date, datetime, timedelta, timezone
from typing import Any
from uuid import UUID

import pytest

from api.modules.notes.hashing import (
    GENESIS_CHAIN_HASH,
    canonical_json,
    content_hash,
    next_chain_hash,
    note_document,
)

NOTE_ID = UUID("00000000-0000-7000-8000-00000000f401")
PROJECT_ID = UUID("00000000-0000-7000-8000-000000001001")
ORG_ID = UUID("00000000-0000-7000-8000-00000000000a")
RECORDER_ID = UUID("00000000-0000-7000-8000-000000000a01")
KST = timezone(timedelta(hours=9))


def _note(**overrides: Any) -> dict[str, Any]:
    note: dict[str, Any] = {
        "note_id": NOTE_ID,
        "project_id": PROJECT_ID,
        "organization_id": ORG_ID,
        "recorder_id": RECORDER_ID,
        "note_date": date(2026, 10, 1),
        "version": 1,
        "previous_version_id": None,
    }
    return note | overrides


def _block(text: str = "40도 이상에서 용량 감소가 뚜렷하다.", **overrides: Any) -> dict[str, Any]:
    block: dict[str, Any] = {
        "block_id": UUID("00000000-0000-7000-8000-00000000f502"),
        "section": "RESULTS",
        "text": text,
        "origin": "HUMAN",
        "accepted": True,
        "evidence": [],
    }
    return block | overrides


def test_canonical_json_sorts_keys_and_drops_insignificant_whitespace() -> None:
    assert (
        canonical_json({"b": 1, "a": [1, {"d": None, "c": True}]}) == b'{"a":[1,{"c":true,"d":null}],"b":1}'
    )
    pretty = json.loads('{\n  "b" : 1,\n  "a" : [ 1 , { "d" : null , "c" : true } ]\n}')
    assert canonical_json(pretty) == canonical_json({"a": [1, {"c": True, "d": None}], "b": 1})


def test_canonical_json_is_utf8_and_nfc_normalized() -> None:
    composed = "한글 노트"
    decomposed = unicodedata.normalize("NFD", composed)
    assert composed != decomposed
    assert canonical_json({"t": decomposed}) == canonical_json({"t": composed})
    assert canonical_json({"t": composed}) == '{"t":"한글 노트"}'.encode()
    assert canonical_json({unicodedata.normalize("NFD", "키"): 1}) == '{"키":1}'.encode()


def test_canonical_json_normalizes_timestamps_dates_and_uuids() -> None:
    utc = datetime(2026, 10, 1, 1, 0, tzinfo=UTC)
    assert canonical_json({"at": utc}) == canonical_json({"at": utc.astimezone(KST)})
    assert canonical_json({"at": utc}) == b'{"at":"2026-10-01T01:00:00.000000Z"}'
    assert canonical_json({"d": date(2026, 10, 1), "u": NOTE_ID}) == (
        b'{"d":"2026-10-01","u":"00000000-0000-7000-8000-00000000f401"}'
    )


@pytest.mark.parametrize("value", [1.5, float("nan"), datetime(2026, 1, 1), object()])
def test_canonical_json_refuses_ambiguous_values(value: Any) -> None:
    with pytest.raises((TypeError, ValueError)):
        canonical_json({"x": value})


def test_document_covers_identity_metadata_and_ordered_blocks() -> None:
    evidence = {
        "type": "RUN_SUCCEEDED",
        "ref_id": str(NOTE_ID),
        "label": "run@3",
        "at": "2026-10-01T14:01:20+09:00",
    }
    doc = note_document(_note(), [_block(origin="AI", accepted=True, evidence=[evidence])])
    assert doc == {
        "note_id": str(NOTE_ID),
        "project_id": str(PROJECT_ID),
        "organization_id": str(ORG_ID),
        "recorder_id": str(RECORDER_ID),
        "note_date": "2026-10-01",
        "version": 1,
        "previous_version_id": None,
        "blocks": [
            {
                "section": "RESULTS",
                "text": "40도 이상에서 용량 감소가 뚜렷하다.",
                "origin": "AI",
                "evidence": [
                    {
                        "type": "RUN_SUCCEEDED",
                        "ref_id": str(NOTE_ID),
                        "label": "run@3",
                        "at": "2026-10-01T05:01:20.000000Z",
                    }
                ],
            }
        ],
    }


def test_content_hash_is_sha256_of_the_canonical_document() -> None:
    note, blocks = _note(), [_block()]
    expected = hashlib.sha256(canonical_json(note_document(note, blocks))).hexdigest()
    assert content_hash(note, blocks) == expected
    assert len(expected) == 64


@pytest.mark.parametrize(
    ("note", "blocks"),
    [
        (_note(version=2), [_block()]),
        (_note(note_date=date(2026, 10, 2)), [_block()]),
        (_note(organization_id=PROJECT_ID), [_block()]),
        (_note(recorder_id=ORG_ID), [_block()]),
        (_note(previous_version_id=NOTE_ID), [_block()]),
        (_note(), [_block("40도 이상에서 용량 감소가 뚜렷하다!")]),
        (_note(), [_block(section="PROCEDURE")]),
        (_note(), [_block(origin="AI")]),
        (_note(), [_block(), _block("둘째")]),
        (_note(), []),
    ],
)
def test_any_content_or_identity_change_changes_the_hash(
    note: dict[str, Any], blocks: list[dict[str, Any]]
) -> None:
    assert content_hash(note, blocks) != content_hash(_note(), [_block()])


def test_block_order_matters_but_block_ids_and_acceptance_do_not() -> None:
    first, second = _block("하나"), _block("둘")
    assert content_hash(_note(), [first, second]) != content_hash(_note(), [second, first])
    assert content_hash(_note(), [_block(block_id=PROJECT_ID, accepted=False)]) == content_hash(
        _note(), [_block()]
    )


def test_chain_hash_links_previous_chain_and_content() -> None:
    h1, h2 = "a" * 64, "b" * 64
    first = next_chain_hash(None, h1)
    assert first == hashlib.sha256((GENESIS_CHAIN_HASH + h1).encode("ascii")).hexdigest()
    assert next_chain_hash(first, h2) == hashlib.sha256((first + h2).encode("ascii")).hexdigest()
    with pytest.raises(ValueError):
        next_chain_hash(first, "not-a-hash")


def test_blocks_are_hashed_in_template_order() -> None:
    """OBJECTIVE, METHOD, PROCEDURE, RESULTS, DISCUSSION, NEXT, REFERENCES; position order within a section."""
    order = ("REFERENCES", "NEXT", "DISCUSSION", "RESULTS", "PROCEDURE", "METHOD", "OBJECTIVE")
    shuffled = [_block(f"{section} 1", section=section) for section in order] + [
        _block("RESULTS 2", section="RESULTS")
    ]
    document = note_document(_note(), shuffled)
    assert [b["text"] for b in document["blocks"]] == [
        "OBJECTIVE 1",
        "METHOD 1",
        "PROCEDURE 1",
        "RESULTS 1",
        "RESULTS 2",
        "DISCUSSION 1",
        "NEXT 1",
        "REFERENCES 1",
    ]
    in_order = sorted(shuffled, key=lambda b: order[::-1].index(b["section"]))
    assert content_hash(_note(), shuffled) == content_hash(_note(), in_order)
    swapped = [_block("RESULTS 2", section="RESULTS"), _block("RESULTS 1", section="RESULTS")]
    assert content_hash(_note(), swapped) != content_hash(_note(), swapped[::-1])
