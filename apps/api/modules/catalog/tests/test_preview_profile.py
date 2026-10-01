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


# ---------------------------------------------------------------- fix round 1: bounded profile, loop limits, parquet


def _profile_bytes(result) -> int:  # type: ignore[no-untyped-def]
    return len(json.dumps(result.column_profile, ensure_ascii=False).encode())


def test_csv_huge_header_names_are_cut_in_profile_and_hints_still_match() -> None:
    names = [f"c{i}" + "가" * 5_000 for i in range(200)]  # ~3 MB header, one record under the record cap
    header = ",".join(f'"{n}"' for n in names).encode() + b"\n"
    hints = {names[0]: FieldHint("number", "u" * 10_000, "d" * 10_000, "http://x/" + "i" * 10_000)}
    result = run(header + b",".join(b"1" for _ in names) + b"\n", hints=hints)
    first = result.column_profile[0]
    assert all(len(c["name"]) == 200 for c in result.column_profile)
    assert first["type"] == "number" and len(first["unit"]) == 200 and len(first["description"]) == 200
    assert first["concept_iri"] is None  # an IRI longer than 512 chars is not a concept IRI
    assert _profile_bytes(result) <= 256 * 1024


def test_csv_header_record_over_cap_is_unparseable() -> None:
    name = ("一" * 1000 + "\n") * 130  # quoted names spanning many physical lines (reviewer case)
    header = ",".join(f'"{name}{i}"' for i in range(200)).encode() + b"\n"
    with pytest.raises(Unparseable):
        run(header + b"1" + b",1" * 199 + b"\n")


def test_header_counts_toward_max_bytes() -> None:
    with pytest.raises(Unparseable):
        run(b"a" * 300 + b",b\n1,2\n", limits=PreviewLimits(max_bytes=100))


def test_huge_hint_text_alone_cannot_blow_up_profile() -> None:
    header = ",".join(f"c{i}" for i in range(200)).encode() + b"\n"
    hints = {f"c{i}": FieldHint(None, "가" * 50_000, "나" * 50_000) for i in range(200)}
    result_or_error: object
    try:
        result_or_error = run(header + b",".join(b"1" for _ in range(200)) + b"\n", hints=hints)
    except Unparseable as exc:
        result_or_error = exc
    if not isinstance(result_or_error, Unparseable):
        assert _profile_bytes(result_or_error) <= 256 * 1024
    hints_small = {"c0": FieldHint(None, "가" * 50_000, "나" * 50_000)}
    ok = run(header + b",".join(b"1" for _ in range(200)) + b"\n", hints=hints_small)
    assert len(ok.column_profile[0]["unit"]) == 200 and _profile_bytes(ok) <= 256 * 1024


def test_profile_over_ceiling_is_unparseable() -> None:
    header = ",".join(f"c{i}" for i in range(200)).encode() + b"\n"
    hints = {f"c{i}": FieldHint(None, "가" * 500, "나" * 500) for i in range(200)}  # 200 × ~1.2 KB UTF-8
    with pytest.raises(Unparseable):
        run(header + b",".join(b"1" for _ in range(200)) + b"\n", hints=hints)


def test_parquet_huge_names_are_cut() -> None:
    sink = io.BytesIO()
    pq.write_table(pa.table({("x" * (1 << 20)) + str(i): [1] for i in range(20)}), sink)
    result = run(sink.getvalue(), path="p.parquet")
    assert all(len(c["name"]) == 200 for c in result.column_profile)
    assert _profile_bytes(result) <= 256 * 1024


def test_many_blank_lines_stop_quickly_as_truncated() -> None:
    import time

    start = time.monotonic()
    result = run(b"a,b\n1,2\n" + b"\n" * (8 << 20))
    assert result.truncated and result.rows_sampled == 1
    assert time.monotonic() - start < 5


def test_many_over_limit_records_stop_at_max_bytes() -> None:
    record = b'"' + (b"x" * 1000 + b"\n") * 200 + b'",1\n'  # one field over the csv field limit
    result = run(b"a,b\n" + record * 40, limits=PreviewLimits(max_bytes=1 << 20))
    assert result.truncated and result.rows_sampled == 0


def test_wide_parquet_reads_only_the_first_columns() -> None:
    import time

    sink = io.BytesIO()
    pq.write_table(
        pa.table({f"c{i}": pa.array(["v" * 1000] * 1024) for i in range(2000)}), sink, compression="zstd"
    )
    data = sink.getvalue()
    requested: list[int] = []

    def open_range(start: int, end: int) -> io.BytesIO:
        requested.append(end - start + 1)
        return io.BytesIO(data[start : end + 1])

    start = time.monotonic()
    result = profile_table(
        open_range, len(data), path="p.parquet", hints={}, limits=PreviewLimits(), deadline=lambda: None
    )
    assert result.columns_truncated and len(result.column_profile) == 200
    assert time.monotonic() - start < 10


def test_nested_bomb_is_skipped_as_other() -> None:
    import time

    n, width = 64, 2_000_000  # 128 M int8 list elements that zstd squeezes to a few KB
    offsets = pa.array(range(0, (n + 1) * width, width), type=pa.int32())
    zeros = pa.Array.from_buffers(pa.int8(), n * width, [None, pa.py_buffer(bytes(n * width))])
    bomb = pa.ListArray.from_arrays(offsets, zeros)
    sink = io.BytesIO()
    pq.write_table(pa.table({"x": pa.array(range(n)), "l": bomb}), sink, compression="zstd", row_group_size=n)
    data = sink.getvalue()
    del bomb
    assert len(data) < 1 << 20
    start = time.monotonic()
    result = run(data, path="p.parquet")
    assert time.monotonic() - start < 2
    dist = {c["name"]: c for c in result.preview["columns"]}
    assert dist["l"]["kind"] == "other" and dist["x"]["kind"] == "numeric"
    assert result.rows_sampled == n and result.preview["rows"][0] == ["0", None]


def test_parquet_binary_is_other_and_byte_budgets() -> None:
    sink = io.BytesIO()
    pq.write_table(pa.table({"b": pa.array([b"\x00\x01"] * 3, type=pa.binary())}), sink)
    assert run(sink.getvalue(), path="p.parquet").preview["columns"][0]["kind"] == "other"
    small = PreviewLimits(max_bytes=1 << 20)
    sink = io.BytesIO()
    pq.write_table(
        pa.table({"s": pa.array([f"{i}" + "y" * 100_000 for i in range(64)])}), sink, compression="zstd"
    )
    result = run(
        sink.getvalue(), path="p.parquet", limits=small
    )  # 6.4 MB decoded: sample stops at the budget
    assert result.truncated and 0 < result.rows_sampled < 64
    sink = io.BytesIO()
    pq.write_table(pa.table({"s": pa.array(["y" * (2 << 20)])}), sink, compression="zstd")
    with pytest.raises(Unparseable):  # a single row over the budget
        run(sink.getvalue(), path="p.parquet", limits=small)


def test_parquet_duplicate_names_and_struct() -> None:
    table = pa.Table.from_arrays(
        [
            pa.array([1, 2]),
            pa.array([{"a": 1, "b": "z"}, {"a": 2, "b": "w"}]),
            pa.array(["p", "q"]),
            pa.array([3, 4]),
        ],
        names=["x", "s", "y", "x"],
    )
    sink = io.BytesIO()
    pq.write_table(table, sink)
    result = run(sink.getvalue(), path="p.parquet")
    assert [c["name"] for c in result.column_profile] == ["x", "s", "y", "x"]
    assert result.preview["rows"][1] == ["2", None, "q", "4"]


def test_parquet_nan_is_missing_and_inf_is_not_categorical() -> None:
    sink = io.BytesIO()
    pq.write_table(pa.table({"f": [1.0, float("nan"), float("inf"), 2.0]}), sink)
    result = run(sink.getvalue(), path="p.parquet")
    col = result.column_profile[0]
    assert col["missing_ratio"] == pytest.approx(0.25)
    dist = result.preview["columns"][0]
    assert dist["kind"] == "numeric" and (dist["min"], dist["max"]) == (1.0, 2.0)
    assert sum(b["count"] for b in dist["histogram"]) == 2  # inf excluded from the histogram
    assert result.preview["rows"][1] == [None] and result.preview["rows"][2] == ["inf"]
    json.dumps(result.preview, allow_nan=False)


def test_narrow_span_histogram_edges_stay_distinct() -> None:
    data = b"x\n" + b"".join(f"{1 + i * 1e-9:.12f}\n".encode() for i in range(100))
    hist = run(data).preview["columns"][0]["histogram"]
    edges = [b["lower"] for b in hist]
    assert len(set(edges)) == len(edges) == 10
