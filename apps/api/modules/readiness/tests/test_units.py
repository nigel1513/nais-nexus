import io
import time
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from api.modules.readiness.engine.context import EvaluationContext
from api.modules.readiness.engine.units import aliases, atoms, prefixes, suggestion, unit_error
from api.modules.readiness.tests.builders import make_ctx, schema_doc, with_schema
from api.modules.readiness.tests.helpers import fixture_files
from api.modules.readiness.validators import units_codebook


@pytest.mark.parametrize(
    "unit",
    [
        "Cel",
        "kPa",
        "mg/L",
        "1",
        "m2",
        "cm-1",
        "/s",
        "kg.m/s2",
        "mm[Hg]",
        "{count}",
        "10*3",
        "[degF]",
        "%",
        "ug/L",
        "mg{total}/dL",
        "(kg.m)/s2",
        "K",
    ],
)
def test_valid_ucum(unit: str) -> None:
    assert unit_error(unit) is None


@pytest.mark.parametrize(
    ("unit", "error"),
    [
        ("degC", "UNKNOWN_ATOM"),
        ("kilopascal", "UNKNOWN_ATOM"),
        ("KPA", "UNKNOWN_ATOM"),  # case-sensitive
        ("kmin", "PREFIX_NOT_ALLOWED"),
        ("m.", "SYNTAX_ERROR"),
        ("(m", "SYNTAX_ERROR"),
        ("m s", "SYNTAX_ERROR"),
        ("", "SYNTAX_ERROR"),
        ("m{a", "SYNTAX_ERROR"),
    ],
)
def test_invalid_ucum(unit: str, error: str) -> None:
    assert unit_error(unit) == error


def test_alias_suggestions_come_from_bundled_table() -> None:
    assert (suggestion("degC"), suggestion("kilopascal"), suggestion("zzz")) == ("Cel", "kPa", None)


FIELDS = [
    {"name": "id", "type": "string"},
    {"name": "t", "type": "number", "unit": "Cel"},
    {"name": "p", "type": "number", "unit": "kPa"},
    {"name": "n", "type": "integer", "unit": "1"},
    {"name": "q", "type": "number", "unit": "mg/L"},
    {"name": "r", "type": "number", "unit": "s"},
]
CSV = b"id,t,p,n,q,r\na,1,2,3,4,5\n"


def _ctx(fields: list[dict[str, Any]], codebook: bytes | None = None, csv: bytes = CSV) -> EvaluationContext:
    files = with_schema({"data/t.csv": csv}, schema_doc("data/t.csv", fields))
    if codebook is not None:
        files["_codebook.csv"] = codebook
    return make_ctx(files=files)


def test_units_pass_on_fixture() -> None:
    outcome = units_codebook.check(make_ctx())
    assert outcome.status == "PASS"
    assert (outcome.evidence["numeric_fields"], outcome.evidence["with_valid_unit"]) == (2, 2)


def test_units_fail_matches_invalid_units_fixture() -> None:
    outcome = units_codebook.check(make_ctx(files=fixture_files("invalid_units")))
    assert outcome.status == "FAIL"
    assert outcome.evidence["invalid_unit"] == [
        {
            "path": "data/measurements.csv",
            "field": "pressure_kpa",
            "unit": "kilopascal",
            "error": "UNKNOWN_ATOM",
        },
        {"path": "data/measurements.csv", "field": "temperature_c", "unit": "degC", "error": "UNKNOWN_ATOM"},
    ]
    assert (
        outcome.message
        == "UCUM 단위로 해석할 수 없는 값이 2개 있습니다 (예: pressure_kpa: kilopascal → kPa)."
    )


def test_missing_unit_ratio_boundary() -> None:
    one_missing = [dict(f) for f in FIELDS]
    one_missing[5].pop("unit")  # 1/5 = 20% -> WARNING
    assert units_codebook.check(_ctx(one_missing)).status == "WARNING"
    two_missing = [dict(f) for f in one_missing]
    two_missing[4].pop("unit")  # 2/5 = 40% -> FAIL
    assert units_codebook.check(_ctx(two_missing)).status == "FAIL"


def test_codebook_unit_row_is_a_source_and_conflicts_warn() -> None:
    fields = [dict(f) for f in FIELDS]
    fields[5].pop("unit")
    codebook = b"path,field,code,label,unit,description\ndata/t.csv,r,,,s,\ndata/t.csv,t,,,K,\n"
    outcome = units_codebook.check(_ctx(fields, codebook))
    assert outcome.status == "WARNING"
    assert outcome.evidence["missing_unit"] == []
    assert outcome.evidence["conflicts"] == [
        {"path": "data/t.csv", "field": "t", "schema_unit": "Cel", "codebook_unit": "K"}
    ]


def test_undefined_codebook_codes_warn_with_counts_only() -> None:
    fields = [*FIELDS, {"name": "m", "type": "string"}]
    csv = b"id,t,p,n,q,r,m\na,1,2,3,4,5,AL\nb,1,2,3,4,5,ZN\n"
    codebook = b"path,field,code,label,unit,description\ndata/t.csv,m,AL,Aluminium,,\n"
    outcome = units_codebook.check(_ctx(fields, codebook, csv))
    assert outcome.status == "WARNING"
    assert outcome.evidence["undefined_code_counts"] == [{"path": "data/t.csv", "field": "m", "undefined": 1}]
    assert "ZN" not in str(outcome.evidence)


def test_no_unit_source_at_all_fails() -> None:
    sink = io.BytesIO()
    pq.write_table(pa.table({"x": pa.array([1.5, 2.5])}), sink)
    outcome = units_codebook.check(make_ctx(files={"data/t.parquet": sink.getvalue()}))
    assert (outcome.status, outcome.evidence["numeric_fields"]) == ("FAIL", 1)


def test_not_applicable_without_numeric_fields() -> None:
    assert (
        units_codebook.check(_ctx([{"name": "id", "type": "string"}], csv=b"id\na\n")).status
        == "NOT_APPLICABLE"
    )
    assert units_codebook.check(make_ctx(files={"README.md": b"#\n"})).status == "NOT_APPLICABLE"


def test_hostile_unit_strings_are_bounded_and_fast() -> None:
    hostile = [
        "(" * 100_000,
        "(" * 5000 + "m" + ")" * 5000,
        "1" * 200_000 + "x",
        "m" + "1" * 200_000 + "x",
        "{" * 100_000,
        "m." * 100_000,
        "{a}" * 100_000,
        "k" * 1_000_000,
        "m." * 127,
        "{a}" * 80,
        "m/" * 120,
    ]
    start = time.perf_counter()
    for unit in hostile:
        assert unit_error(unit) in (None, "SYNTAX_ERROR")
    assert time.perf_counter() - start < 2.0


def test_reasonable_nesting_still_valid_and_dictionaries_are_stable() -> None:
    assert unit_error("((kg.m)/s2)/(m)") is None
    assert unit_error("(" * 16 + "m" + ")" * 16) is None
    assert unit_error("(" * 17 + "m" + ")" * 17) == "SYNTAX_ERROR"  # nesting cap
    assert atoms()["Cel"] is True and atoms()["min"] is False
    assert prefixes()[0] == "da" and aliases()["degC"] == "Cel"


def test_under_cap_adversarial_strings_have_expected_results() -> None:
    assert unit_error("m." * 127) == "SYNTAX_ERROR"  # trailing dot
    assert unit_error("m." * 126 + "m") is None
    assert unit_error("{a}" * 80) == "SYNTAX_ERROR"  # adjacent annotations
    assert unit_error("{a}") is None
    assert unit_error("m/" * 120) == "SYNTAX_ERROR"


def test_missing_unit_threshold_compares_exact_fraction() -> None:
    # 1/3 = 0.3333333 rounds to 0.333333 for evidence but is above a 0.333333 limit.
    fields = [
        {"name": "a", "type": "number", "unit": "s"},
        {"name": "b", "type": "number", "unit": "s"},
        {"name": "c", "type": "number"},
    ]
    files = with_schema({"data/t.csv": b"a,b,c\n1,2,3\n"}, schema_doc("data/t.csv", fields))
    outcome = units_codebook.check(make_ctx(files=files, unit_missing_fail_ratio=0.333333))
    assert (outcome.status, outcome.evidence["missing_unit_ratio"]) == ("FAIL", 0.333333)


def test_long_unit_is_truncated_in_message_only() -> None:
    long_unit = "x" * 100
    fields = [{"name": "a", "type": "number", "unit": long_unit}]
    files = with_schema({"data/t.csv": b"a\n1\n"}, schema_doc("data/t.csv", fields))
    outcome = units_codebook.check(make_ctx(files=files))
    assert outcome.evidence["invalid_unit"][0]["unit"] == long_unit
    assert long_unit not in outcome.message and "x" * 64 + "…" in outcome.message
