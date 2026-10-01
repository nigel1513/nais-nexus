import io
import json

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from api.modules.catalog.previews.profile import (
    FieldHint,
    PreviewLimits,
    PreviewTimeout,
    Unparseable,
    make_deadline,
    profile_table,
    table_format,
)
from api.modules.catalog.previews.schema_hints import parse_schema_hints


def run(data: bytes, path: str = "data/m.csv", hints=None, limits: PreviewLimits | None = None):  # type: ignore[no-untyped-def]
    return profile_table(
        lambda start, end: io.BytesIO(data[start : end + 1]),
        len(data),
        path=path,
        hints=hints or {},
        limits=limits or PreviewLimits(),
        deadline=lambda: None,
    )


CSV = b"sample_id,temperature_c,material,note\n" + b"".join(
    f"S{i:04d},{20 + (i % 61)}.5,{['AL', 'CU', 'FE'][i % 3]},{'' if i % 10 == 0 else 'ok'}\n".encode()
    for i in range(1000)
)


def test_table_format() -> None:
    assert [table_format(p) for p in ("a.csv", "b.TSV", "c.parquet", "_schema.json", "_x.csv", "r.md")] == [
        "csv",
        "tsv",
        "parquet",
        None,
        None,
        None,
    ]


def test_csv_profile_types_missing_distinct() -> None:
    result = run(CSV)
    cols = {c["name"]: c for c in result.column_profile}
    assert result.format == "csv" and result.rows_sampled == 1000 and not result.truncated
    assert cols["temperature_c"]["type"] == "number" and cols["sample_id"]["type"] == "string"
    assert cols["note"]["missing_ratio"] == pytest.approx(0.1)
    assert cols["material"]["distinct_count"] == 3 and cols["material"]["distinct_capped"] is False
    assert all(
        set(c)
        <= {
            "name",
            "type",
            "unit",
            "description",
            "concept_iri",
            "missing_ratio",
            "distinct_count",
            "distinct_capped",
        }
        for c in result.column_profile
    )


def test_preview_distributions_and_rows() -> None:
    preview = run(CSV).preview
    dist = {c["name"]: c for c in preview["columns"]}
    assert dist["temperature_c"]["kind"] == "numeric"
    assert dist["temperature_c"]["min"] == 20.5 and dist["temperature_c"]["max"] == 80.5
    assert sum(b["count"] for b in dist["temperature_c"]["histogram"]) == 1000
    assert len(dist["temperature_c"]["histogram"]) == 10
    assert dist["material"]["kind"] == "categorical"
    assert {v["value"] for v in dist["material"]["top_values"]} == {"AL", "CU", "FE"}
    assert preview["header"] == ["sample_id", "temperature_c", "material", "note"]
    assert len(preview["rows"]) == 100 and preview["rows"][0] == ["S0000", "20.5", "AL", None]


def test_cells_are_truncated_and_payload_capped() -> None:
    wide = b"a,b\n" + b"".join(b"<script>" + b"x" * 5000 + b",1\n" for _ in range(300))
    preview = run(wide).preview
    assert all(len(row[0]) == 200 for row in preview["rows"])
    assert len(json.dumps(preview).encode()) <= 256 * 1024


def test_limits_mark_truncation() -> None:
    result = run(CSV, limits=PreviewLimits(max_rows=50))
    assert result.truncated and result.rows_sampled == 50


def test_too_many_columns_are_dropped() -> None:
    header = ",".join(f"c{i}" for i in range(250)).encode() + b"\n"
    result = run(header + b",".join(b"1" for _ in range(250)) + b"\n")
    assert result.columns_truncated and len(result.column_profile) == 200


def test_long_line_is_unparseable_and_deadline_times_out() -> None:
    with pytest.raises(Unparseable):
        run(b"a\n" + b"x" * (2 << 20) + b"\n")

    def expired() -> None:
        raise PreviewTimeout

    with pytest.raises(PreviewTimeout):
        profile_table(
            lambda s, e: io.BytesIO(CSV[s : e + 1]),
            len(CSV),
            path="m.csv",
            hints={},
            limits=PreviewLimits(),
            deadline=expired,
        )


def test_tsv_and_parquet() -> None:
    assert run(b"a\tb\n1\t2\n", path="t.tsv").column_profile[1]["type"] == "integer"
    sink = io.BytesIO()
    pq.write_table(pa.table({"x": [1.5, 2.5, None], "y": ["a", "b", "a"]}), sink)
    result = run(sink.getvalue(), path="p.parquet")
    cols = {c["name"]: c for c in result.column_profile}
    assert result.format == "parquet" and cols["x"]["type"] == "number"
    assert cols["x"]["missing_ratio"] == pytest.approx(1 / 3)
    assert result.preview["rows"][2] == [None, "a"]


def test_schema_hints_override_type_and_add_units() -> None:
    raw = json.dumps(
        {
            "resources": [
                {
                    "path": "data/m.csv",
                    "schema": {
                        "fields": [
                            {
                                "name": "temperature_c",
                                "type": "number",
                                "unit": "Cel",
                                "description": "시편 온도",
                                "x-nais-concept": "http://qudt.org/vocab/quantitykind/Temperature",
                            }
                        ]
                    },
                }
            ]
        }
    ).encode()
    hints = parse_schema_hints(raw)
    assert hints["data/m.csv"]["temperature_c"] == FieldHint(
        "number", "Cel", "시편 온도", "http://qudt.org/vocab/quantitykind/Temperature"
    )
    col = {c["name"]: c for c in run(CSV, hints=hints["data/m.csv"]).column_profile}["temperature_c"]
    assert (col["unit"], col["concept_iri"]) == ("Cel", "http://qudt.org/vocab/quantitykind/Temperature")
    assert parse_schema_hints(b"{not json") == {}


# ---------------------------------------------------------------- hardening (rulings P1, P2, P8, P17)


def test_overflow_inside_quoted_field_is_unparseable() -> None:
    with pytest.raises(Unparseable):
        run(b'a,b\n1,2\n"' + b"x" * (2 << 20) + b'",3\n')


def test_overflow_after_good_rows_is_unparseable_not_ready() -> None:
    with pytest.raises(Unparseable):
        run(CSV + b"x" * (2 << 20) + b"\n")


def test_wide_file_drops_distributions_to_fit_budget() -> None:
    cols = 200
    header = ",".join(f"c{i}" for i in range(cols)).encode() + b"\n"
    body = b"".join(
        ",".join(f"{i % 40:02d}" + "가" * 190 for _ in range(cols)).encode() + b"\n" for i in range(400)
    )
    result = run(header + body)
    preview = result.preview
    assert len(json.dumps(preview).encode()) <= 256 * 1024
    assert preview["rows"] == [] and preview["rows_truncated"] is True
    assert preview["columns"] == [] and "distributions_truncated" not in preview
    assert preview["header"] == [f"c{i}" for i in range(cols)]
    assert len(result.column_profile) == cols  # metadata profile is unaffected


def test_top_values_and_bins_are_capped_even_if_limits_ask_for_more() -> None:
    data = b"n,c\n" + b"".join(f"{i},v{i % 30}\n".encode() for i in range(500))
    preview = run(data, limits=PreviewLimits(histogram_bins=100, top_values=50)).preview
    dist = {c["name"]: c for c in preview["columns"]}
    assert len(dist["n"]["histogram"]) == 20 and sum(b["count"] for b in dist["n"]["histogram"]) == 500
    assert len(dist["c"]["top_values"]) == 10
    assert set(preview) == {"header", "rows", "rows_truncated", "columns"}


def test_huge_header_names_still_fit_budget() -> None:
    header = ",".join(f"c{i}" + "\U0001f600" * 300 for i in range(200)).encode() + b"\n"
    preview = run(header + b",".join(b"1" for _ in range(200)) + b"\n").preview
    assert len(json.dumps(preview).encode()) <= 256 * 1024


def test_extreme_floats_never_produce_non_json_numbers() -> None:
    data = b"x\n-1.7e308\n1.7e308\n1e400\n0\n"
    preview = run(data).preview
    json.dumps(preview, allow_nan=False)  # raises on inf / nan
    hist = {c["name"]: c for c in preview["columns"]}["x"]["histogram"]
    assert sum(b["count"] for b in hist) == 3


def test_long_values_skip_type_regexes() -> None:
    data = b"x\n" + b"1" * 100 + b"\n"
    assert run(data).column_profile[0]["type"] == "string"


def test_make_deadline_raises_preview_timeout() -> None:
    now = [0.0]
    check = make_deadline(5, clock=lambda: now[0])
    check()
    now[0] = 6.0
    with pytest.raises(PreviewTimeout):
        check()


def _parquet_bytes() -> bytes:
    sink = io.BytesIO()
    pq.write_table(pa.table({"x": list(range(5000))}), sink, row_group_size=500)
    return sink.getvalue()


def test_parquet_deadline_times_out() -> None:
    data = _parquet_bytes()
    calls = [0]

    def deadline() -> None:
        calls[0] += 1
        if calls[0] > 3:
            raise PreviewTimeout

    with pytest.raises(PreviewTimeout):
        profile_table(
            lambda s, e: io.BytesIO(data[s : e + 1]),
            len(data),
            path="p.parquet",
            hints={},
            limits=PreviewLimits(),
            deadline=deadline,
        )


def test_corrupt_parquet_is_unparseable_and_storage_errors_propagate() -> None:
    with pytest.raises(Unparseable):
        run(b"PAR1" + b"\x00" * 100 + b"PAR1", path="p.parquet")
    data = _parquet_bytes()

    def broken(start: int, end: int) -> io.BytesIO:
        raise ConnectionError("storage down")

    with pytest.raises(ConnectionError):
        profile_table(
            broken, len(data), path="p.parquet", hints={}, limits=PreviewLimits(), deadline=lambda: None
        )


def test_parquet_rows_are_capped() -> None:
    result = run(_parquet_bytes(), path="p.parquet", limits=PreviewLimits(max_rows=700))
    assert result.truncated and result.rows_sampled == 700


def test_empty_and_header_only() -> None:
    with pytest.raises(Unparseable):
        run(b"")
    result = run(b"a,b\n")
    assert result.rows_sampled == 0 and [c["name"] for c in result.column_profile] == ["a", "b"]
