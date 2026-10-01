import io
import json

import pyarrow as pa
import pyarrow.parquet as pq

from api.modules.readiness.engine.context import DEFAULT_MISSING, parse_codebook, parse_schema_doc
from api.modules.readiness.tests.builders import make_ctx, schema_doc, with_schema
from api.modules.readiness.tests.helpers import fixture_files
from api.modules.readiness.validators import mapping_status, schema_presence

FIELDS = [
    {"name": "a", "type": "integer", "x-nais-concept": "https://example.org/a"},
    {"name": "b", "type": "string", "x-nais-concept": "https://example.org/b"},
]


def _base() -> dict[str, bytes]:
    return {"README.md": b"# t\n", "data/t.csv": b"a,b\n1,x\n"}


def _parquet_bytes() -> bytes:
    sink = io.BytesIO()
    pq.write_table(pa.table({"a": [1, 2]}), sink)
    return sink.getvalue()


# ---------------------------------------------------------------- schema.presence


def test_schema_presence_pass_on_fixture() -> None:
    outcome = schema_presence.check(make_ctx())
    assert outcome.status == "PASS"
    assert (outcome.evidence["tabular_files"], outcome.evidence["described"]) == (1, 1)


def test_not_applicable_without_tabular_files() -> None:
    files = {"README.md": b"# t\n", "raw/scan.h5": b"\x89HDF", "_notes.csv": b"a\n1\n"}
    assert schema_presence.check(make_ctx(files=files)).status == "NOT_APPLICABLE"


def test_missing_schema_fails_for_csv_but_warns_for_parquet_only() -> None:
    assert schema_presence.check(make_ctx(files=_base())).status == "FAIL"
    parquet_only = {"README.md": b"# t\n", "data/t.parquet": _parquet_bytes()}
    assert schema_presence.check(make_ctx(files=parquet_only)).status == "WARNING"


def test_invalid_json_and_subset_violations_fail_with_pointers() -> None:
    outcome = schema_presence.check(make_ctx(files={**_base(), "_schema.json": b"{not json"}))
    assert (outcome.status, outcome.evidence["schema_errors"]) == (
        "FAIL",
        [{"pointer": "", "error": "json_parse"}],
    )
    bad_type = with_schema(_base(), schema_doc("data/t.csv", [{"name": "a", "type": "float"}]))
    outcome = schema_presence.check(make_ctx(files=bad_type))
    assert outcome.status == "FAIL"
    assert outcome.evidence["schema_errors"] == [
        {"pointer": "/resources/0/schema/fields/0/type", "error": "enum"}
    ]


def test_undescribed_csv_fails_and_undescribed_parquet_warns() -> None:
    files = with_schema({**_base(), "data/u.csv": b"z\n1\n"}, schema_doc("data/t.csv", FIELDS))
    outcome = schema_presence.check(make_ctx(files=files))
    assert (outcome.status, outcome.evidence["undescribed"]) == ("FAIL", ["data/u.csv"])
    files = with_schema({**_base(), "data/u.parquet": _parquet_bytes()}, schema_doc("data/t.csv", FIELDS))
    outcome = schema_presence.check(make_ctx(files=files))
    assert (outcome.status, outcome.evidence["undescribed"]) == ("WARNING", ["data/u.parquet"])


def test_header_mismatch_rules() -> None:
    missing_col = with_schema({**_base(), "data/t.csv": b"a\n1\n"}, schema_doc("data/t.csv", FIELDS))
    outcome = schema_presence.check(make_ctx(files=missing_col))
    assert outcome.status == "FAIL"
    assert outcome.evidence["header_mismatch"] == [
        {"path": "data/t.csv", "missing_in_header": ["b"], "undeclared_columns": []}
    ]
    extra_col = with_schema({**_base(), "data/t.csv": b"a,b,note\n1,x,y\n"}, schema_doc("data/t.csv", FIELDS))
    outcome = schema_presence.check(make_ctx(files=extra_col))
    assert outcome.status == "WARNING"
    assert outcome.evidence["header_mismatch"][0]["undeclared_columns"] == ["note"]
    case = with_schema({**_base(), "data/t.csv": b"A,b\n1,x\n"}, schema_doc("data/t.csv", FIELDS))
    assert schema_presence.check(make_ctx(files=case)).status == "FAIL"  # names are case-sensitive
    dup = with_schema({**_base(), "data/t.csv": b"a,b,a\n1,x,2\n"}, schema_doc("data/t.csv", FIELDS))
    outcome = schema_presence.check(make_ctx(files=dup))
    assert (outcome.status, outcome.evidence["header_mismatch"][0]["duplicate_columns"]) == ("FAIL", ["a"])


def test_resource_path_not_in_version_fails() -> None:
    doc = {
        "resources": schema_doc("data/t.csv", FIELDS)["resources"]
        + schema_doc("data/gone.csv", FIELDS)["resources"]
    }
    outcome = schema_presence.check(make_ctx(files=with_schema(_base(), doc)))
    assert (outcome.status, outcome.evidence["unknown_resource_paths"]) == ("FAIL", ["data/gone.csv"])


def test_tabular_cap_records_skipped_files() -> None:
    files = {f"data/{i:02d}.csv": b"a\n1\n" for i in range(3)}
    doc = {
        "resources": [{"path": p, "schema": {"fields": [{"name": "a", "type": "integer"}]}} for p in files]
    }
    outcome = schema_presence.check(make_ctx(files=with_schema(files, doc), max_tabular_files=2))
    assert outcome.evidence["tabular_files"] == 2
    assert outcome.evidence["skipped_files"] == ["data/02.csv"]


# ---------------------------------------------------------------- semantics.mapping_status


def test_mapping_pass_on_fixture() -> None:
    outcome = mapping_status.check(make_ctx())
    assert outcome.status == "PASS"
    assert outcome.evidence == {
        "declared_fields": 5,
        "mapped_fields": 5,
        "ratio": 1.0,
        "unmapped": [],
        "malformed_iri": [],
    }


def test_mapping_boundary_and_malformed_iri() -> None:
    fields = [{"name": f"f{i}", "type": "string", "x-nais-concept": f"https://e.org/{i}"} for i in range(4)]
    fields.append({"name": "f4", "type": "string", "x-nais-concept": "urn:not-http"})
    csv = (",".join(f["name"] for f in fields) + "\n" + ",".join("x" for _ in fields) + "\n").encode()
    outcome = mapping_status.check(
        make_ctx(files=with_schema({"data/t.csv": csv}, schema_doc("data/t.csv", fields)))
    )
    assert (outcome.status, outcome.evidence["ratio"]) == ("PASS", 0.8)  # exactly 80%
    assert outcome.evidence["malformed_iri"] == [{"path": "data/t.csv", "field": "f4"}]
    fields[3].pop("x-nais-concept")
    outcome = mapping_status.check(
        make_ctx(files=with_schema({"data/t.csv": csv}, schema_doc("data/t.csv", fields)))
    )
    assert outcome.status == "WARNING"


def test_mapping_not_applicable_without_valid_schema() -> None:
    files = {k: v for k, v in fixture_files().items() if k != "_schema.json"}
    assert mapping_status.check(make_ctx(files=files)).status == "NOT_APPLICABLE"
    files["_schema.json"] = json.dumps({"resources": "nope"}).encode()
    assert mapping_status.check(make_ctx(files=files)).status == "NOT_APPLICABLE"


# ---------------------------------------------------------------- parse_schema_doc / parse_codebook


def test_parse_schema_doc_valid_and_defaults() -> None:
    raw = json.dumps(
        {
            "resources": [
                {
                    "path": "data/t.csv",
                    "schema": {
                        "fields": [
                            {"name": "a", "type": "integer", "unit": "mm", "constraints": {"required": True}},
                            {"name": "b", "type": "string", "x-nais-concept": "https://e.org/b"},
                        ],
                        "primaryKey": "a",
                    },
                },
                {"path": "data/t.csv", "schema": {"fields": [{"name": "z", "type": "string"}]}},
            ]
        }
    ).encode()
    doc = parse_schema_doc(b"\xef\xbb\xbf" + raw)  # BOM tolerated
    assert (doc.present, doc.valid, doc.errors) == (True, True, ())
    resource = doc.resources["data/t.csv"]  # first description of a path wins
    assert [f.name for f in resource.fields] == ["a", "b"]
    assert (resource.fields[0].unit, resource.fields[0].required) == ("mm", True)
    assert resource.fields[1].concept == "https://e.org/b"
    assert resource.primary_key == ("a",)
    assert resource.missing_values == DEFAULT_MISSING


def test_parse_schema_doc_invalid_inputs() -> None:
    assert parse_schema_doc(b"\xff\xfe").errors == ({"pointer": "", "error": "json_parse"},)
    doc = parse_schema_doc(json.dumps({"resources": "nope"}).encode())
    assert (doc.present, doc.valid) == (True, False)
    assert doc.errors and doc.resources == {}


def test_parse_codebook_units_and_codes() -> None:
    raw = b"path,field,code,unit\ndata/t.csv,a,,mm\ndata/t.csv,b,X,\ndata/t.csv,b,Y,\n"
    book = parse_codebook(b"\xef\xbb\xbf" + raw)
    assert book.present
    assert book.units == {("data/t.csv", "a"): "mm"}
    assert book.codes == {("data/t.csv", "b"): frozenset({"X", "Y"})}
    assert parse_codebook(b"\xff\xfe\x00").units == {}
    assert parse_codebook(b"\xff\xfe\x00").present
