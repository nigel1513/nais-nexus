from typing import Any

from api.modules.readiness.tests.builders import make_ctx, schema_doc, with_schema
from api.modules.readiness.validators import datatype_validity, missing_values

FIELDS = [{"name": "id", "type": "string"}, {"name": "v", "type": "number"}]


def _files(values: list[str], fields: list[dict[str, Any]] | None = None, **schema: Any) -> dict[str, bytes]:
    body = "id,v\n" + "".join(f"r{i},{v}\n" for i, v in enumerate(values, start=1))
    return with_schema({"data/t.csv": body.encode()}, schema_doc("data/t.csv", fields or FIELDS, **schema))


# ---------------------------------------------------------------- schema.datatype_validity


def test_datatype_pass_on_fixture() -> None:
    outcome = datatype_validity.check(make_ctx())
    assert outcome.status == "PASS"
    assert outcome.evidence == {
        "files": [
            {
                "path": "data/measurements.csv",
                "sampled_rows": 1000,
                "truncated": False,
                "malformed_rows": 0,
                "encoding_error": False,
            }
        ],
        "fields": [],
    }


def test_datatype_warning_at_exactly_one_percent_and_fail_above() -> None:
    warn = datatype_validity.check(make_ctx(files=_files(["x"] + ["1.5"] * 99)))
    assert warn.status == "WARNING"
    assert warn.evidence["fields"] == [
        {
            "path": "data/t.csv",
            "field": "v",
            "declared_type": "number",
            "checked": 100,
            "invalid": 1,
            "invalid_ratio": 0.01,
            "first_invalid_rows": [1],
        }
    ]
    assert datatype_validity.check(make_ctx(files=_files(["x", "y"] + ["1.5"] * 98))).status == "FAIL"


def test_missing_tokens_are_not_type_checked() -> None:
    assert datatype_validity.check(make_ctx(files=_files(["", "NA", "1"]))).status == "PASS"


def test_first_invalid_rows_capped_at_ten() -> None:
    outcome = datatype_validity.check(make_ctx(files=_files(["bad"] * 12)))
    assert outcome.evidence["fields"][0]["first_invalid_rows"] == list(range(1, 11))


def test_malformed_rows_warn_then_fail() -> None:
    rows = "id,v\n" + "".join(f"r{i},1\n" for i in range(1, 1000)) + "broken\n"
    ctx = make_ctx(files=with_schema({"data/t.csv": rows.encode()}, schema_doc("data/t.csv", FIELDS)))
    assert datatype_validity.check(ctx).status == "WARNING"  # 1/1000 = 0.1% is not above the limit
    rows += "broken\n"
    ctx = make_ctx(files=with_schema({"data/t.csv": rows.encode()}, schema_doc("data/t.csv", FIELDS)))
    assert datatype_validity.check(ctx).status == "FAIL"


def test_encoding_error_fails() -> None:
    files = with_schema({"data/t.csv": b"id,v\nr1,\xff\n"}, schema_doc("data/t.csv", FIELDS))
    outcome = datatype_validity.check(make_ctx(files=files))
    assert (outcome.status, outcome.evidence["files"][0]["encoding_error"]) == ("FAIL", True)


def test_datatype_not_applicable_when_nothing_evaluable() -> None:
    assert datatype_validity.check(make_ctx(files={"data/t.csv": b"a\n1\n"})).status == "NOT_APPLICABLE"
    assert datatype_validity.check(make_ctx(files={"README.md": b"#\n"})).status == "NOT_APPLICABLE"


def test_evidence_never_contains_cell_values() -> None:
    outcome = datatype_validity.check(make_ctx(files=_files(["SECRET-VALUE-123"] + ["1"] * 5)))
    assert "SECRET-VALUE-123" not in str(outcome.evidence) + outcome.message


# ---------------------------------------------------------------- data.missing_values


def test_missing_pass_on_fixture_lists_pressure() -> None:
    outcome = missing_values.check(make_ctx())
    assert outcome.status == "PASS"
    assert outcome.evidence == {
        "overall_missing_ratio": 0.002,
        "fields": [{"path": "data/measurements.csv", "field": "pressure_kpa", "missing": 10, "ratio": 0.01}],
        "required_field_violations": [],
    }


def test_missing_field_boundaries() -> None:
    five_pct = ["", *["1"] * 19]  # field 1/20 = 5% (not above), overall 1/40
    assert missing_values.check(make_ctx(files=_files(five_pct))).status == "PASS"
    ten_pct = ["", "", *["1"] * 18]  # field 10%, overall exactly 5%
    assert missing_values.check(make_ctx(files=_files(ten_pct))).status == "WARNING"
    half = ["", "1"]  # 50% is not above the FAIL limit
    assert missing_values.check(make_ctx(files=_files(half))).status == "WARNING"
    assert missing_values.check(make_ctx(files=_files(["", "", "1"]))).status == "FAIL"


def test_required_and_primary_key_fields_must_not_be_missing() -> None:
    fields = [
        {"name": "id", "type": "string"},
        {"name": "v", "type": "number", "constraints": {"required": True}},
    ]
    outcome = missing_values.check(make_ctx(files=_files(["1"] * 99 + [""], fields)))
    assert outcome.status == "FAIL"
    assert outcome.evidence["required_field_violations"] == [
        {"path": "data/t.csv", "field": "v", "missing": 1}
    ]
    pk = with_schema({"data/t.csv": b"id,v\n,1\nr2,2\n"}, schema_doc("data/t.csv", FIELDS, primaryKey="id"))
    assert missing_values.check(make_ctx(files=pk)).status == "FAIL"


def test_resource_missing_values_override_defaults() -> None:
    outcome = missing_values.check(make_ctx(files=_files(["-999", "1", "2", "3"], missingValues=["-999"])))
    assert outcome.evidence["fields"] == [{"path": "data/t.csv", "field": "v", "missing": 1, "ratio": 0.25}]
    outcome = missing_values.check(make_ctx(files=_files(["NA", "1", "2", "3"], missingValues=["-999"])))
    assert outcome.evidence["fields"] == []  # "NA" is a value for this resource


def test_undescribed_csv_uses_default_tokens() -> None:
    outcome = missing_values.check(make_ctx(files={"data/t.csv": b"a\nNULL\n1\n1\n1\n"}))
    assert outcome.evidence["fields"] == [{"path": "data/t.csv", "field": "a", "missing": 1, "ratio": 0.25}]


def test_missing_not_applicable_without_tabular() -> None:
    assert missing_values.check(make_ctx(files={"README.md": b"#\n"})).status == "NOT_APPLICABLE"


def test_header_only_file_has_zero_ratios() -> None:
    """Review focus: a csv with a header and no rows must not divide by zero."""
    files = with_schema({"data/t.csv": b"id,v\n"}, schema_doc("data/t.csv", FIELDS))
    datatype = datatype_validity.check(make_ctx(files=files))
    assert (datatype.status, datatype.evidence["files"][0]["sampled_rows"]) == ("PASS", 0)
    missing = missing_values.check(make_ctx(files=files))
    assert (missing.status, missing.evidence["overall_missing_ratio"]) == ("PASS", 0.0)


def test_tsv_uses_tab_delimiter() -> None:
    files = with_schema({"data/t.tsv": b"id\tv\nr1\t1,5\n"}, schema_doc("data/t.tsv", FIELDS))
    outcome = datatype_validity.check(make_ctx(files=files))
    assert outcome.evidence["fields"][0]["field"] == "v"  # "1,5" is one (invalid) number, not two columns
