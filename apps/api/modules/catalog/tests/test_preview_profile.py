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
    assert result.total_rows == 1000  # read to the end: the count is exact
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
    assert result.total_rows is None  # a truncated CSV sample does not know the total


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
    tsv = run(b"a\tb\n1\t2\n", path="t.tsv")
    assert tsv.column_profile[1]["type"] == "integer" and tsv.total_rows == 1
    sink = io.BytesIO()
    pq.write_table(pa.table({"x": [1.5, 2.5, None], "y": ["a", "b", "a"]}), sink)
    result = run(sink.getvalue(), path="p.parquet")
    cols = {c["name"]: c for c in result.column_profile}
    assert result.format == "parquet" and cols["x"]["type"] == "number" and result.total_rows == 3
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
    assert result.total_rows is not None and result.total_rows > 700  # parquet metadata knows the total


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


def test_wide_korean_hints_degrade_instead_of_failing() -> None:
    names = [f"{i:03d}" + "열" * 197 for i in range(200)]
    header = ",".join(names).encode() + b"\n"
    hints = {n: FieldHint("number", "단" * 200, "설" * 200, "http://qudt.org/x") for n in names}
    result = run(header + b",".join(b"1" for _ in names) + b"\n", hints=hints)
    assert _profile_bytes(result) <= 256 * 1024
    first = result.column_profile[0]
    assert first["description"] is None and first["type"] == "number"
    assert len({c["name"] for c in result.column_profile}) == 200
    assert set(first) == {
        "name",
        "type",
        "unit",
        "description",
        "concept_iri",
        "missing_ratio",
        "distinct_count",
        "distinct_capped",
    }


def test_profile_degrades_in_order_then_fails() -> None:
    header = b"a,b\n1,2\n"
    hints = {"a": FieldHint(None, "u" * 100, "d" * 150, "http://x/y")}
    base = run(header, hints=hints).column_profile[0]
    assert (base["unit"], base["description"]) == ("u" * 100, "d" * 150)
    size_full = _profile_bytes(run(header, hints=hints))
    no_desc = run(header, hints=hints, limits=PreviewLimits(profile_bytes=size_full - 1)).column_profile[0]
    assert no_desc["description"] is None and no_desc["unit"] == "u" * 100
    no_unit = run(header, hints=hints, limits=PreviewLimits(profile_bytes=size_full - 150)).column_profile[0]
    assert no_unit["unit"] is None and no_unit["concept_iri"] is None
    with pytest.raises(Unparseable):
        run(header, hints=hints, limits=PreviewLimits(profile_bytes=50))


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
    strings = pa.table({"s": pa.array([f"{i}" + "y" * 100_000 for i in range(64)])})
    pq.write_table(strings, sink, compression="zstd", use_dictionary=False)
    result = run(sink.getvalue(), path="p.parquet", limits=small)  # 6.4 MB decoded: stops at the budget
    assert result.truncated and 0 < result.rows_sampled < 64
    sink = io.BytesIO()
    pq.write_table(strings, sink, compression="zstd")  # a 6.4 MB dictionary page > max_bytes / 4
    assert run(sink.getvalue(), path="p.parquet", limits=small).preview["columns"][0]["kind"] == "other"
    sink = io.BytesIO()
    pq.write_table(
        pa.table({"s": pa.array(["y" * (2 << 20)])}), sink, compression="zstd", use_dictionary=False
    )
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


# ---------------------------------------------------------------- fix round 2: large row groups degrade


def _single_row_group_floats(
    rows: int, columns: int, page_size: int = 1 << 20, dictionary: bool = True
) -> bytes:
    import os

    table = pa.table(
        {
            f"f{i}": pa.Array.from_buffers(pa.float64(), rows, [None, pa.py_buffer(os.urandom(rows * 8))])
            for i in range(columns)
        }
    )
    sink = io.BytesIO()
    pq.write_table(table, sink, row_group_size=rows, data_page_size=page_size, use_dictionary=dictionary)
    return sink.getvalue()


def test_large_single_row_group_streams_and_truncates() -> None:
    import time

    data = _single_row_group_floats(1_000_000, 12)  # ~94 MB, one row group (pyarrow's default size)
    assert len(data) > 90 << 20 and pq.ParquetFile(io.BytesIO(data)).metadata.num_row_groups == 1
    fetched = [0]

    def open_range(start: int, end: int) -> io.BytesIO:
        fetched[0] += end - start + 1
        return io.BytesIO(data[start : end + 1])

    start = time.monotonic()
    result = profile_table(
        open_range, len(data), path="p.parquet", hints={}, limits=PreviewLimits(), deadline=lambda: None
    )
    elapsed = time.monotonic() - start
    assert result.truncated and result.rows_sampled == 10_000
    assert fetched[0] < 64 << 20  # pages are streamed, never the whole chunks
    assert elapsed < 10


def test_small_budget_reads_fewer_columns_and_truncates() -> None:
    data = _single_row_group_floats(400_000, 4, page_size=64 << 10, dictionary=False)  # 3.2 MB chunks
    result = run(data, path="p.parquet", limits=PreviewLimits(max_rows=400_000, max_bytes=2 << 20))
    kinds = [c["kind"] for c in result.preview["columns"]]
    assert result.truncated and 0 < result.rows_sampled < 400_000
    assert kinds == ["numeric", "other", "other", "other"]


def test_fetch_budget_truncates_or_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    from api.modules.catalog.previews import profile as profile_module

    data = _single_row_group_floats(400_000, 4, page_size=64 << 10, dictionary=False)
    limits = PreviewLimits(max_rows=400_000, max_bytes=4 << 20)
    monkeypatch.setattr(profile_module, "PARQUET_FETCH_FACTOR", 0.5)  # fetch cap 2 MiB, decoded budget 4 MiB
    result = run(data, path="p.parquet", limits=limits)
    assert result.truncated and 0 < result.rows_sampled < 400_000
    monkeypatch.setattr(profile_module, "PARQUET_FETCH_FACTOR", 0)  # nothing may be fetched past the footer
    with pytest.raises(Unparseable):
        run(data, path="p.parquet", limits=limits)


def test_wide_large_row_group_parquet_reads_fewer_columns_instead_of_failing() -> None:
    import os

    rows, width = 100_000, 60  # 60 columns × 800 KB chunks: first-batch pages exceed an 8 MiB budget
    table = pa.table(
        {
            f"f{i}": pa.Array.from_buffers(pa.float64(), rows, [None, pa.py_buffer(os.urandom(rows * 8))])
            for i in range(width)
        }
    )
    sink = io.BytesIO()
    pq.write_table(table, sink, row_group_size=rows, use_dictionary=False)
    result = run(sink.getvalue(), path="p.parquet", limits=PreviewLimits(max_bytes=8 << 20))
    kinds = [c["kind"] for c in result.preview["columns"]]
    assert result.rows_sampled > 0 and kinds.count("numeric") >= 5 and kinds[-1] == "other"


def test_skewed_first_batch_retries_row_by_row() -> None:
    values = ["y" * (3 << 20)] + ["s"] * 999  # average row is tiny, the first row is not
    sink = io.BytesIO()
    pq.write_table(pa.table({"s": values}), sink, compression="zstd", use_dictionary=False)
    with pytest.raises(Unparseable):  # the single first row alone is over the budget
        run(sink.getvalue(), path="p.parquet", limits=PreviewLimits(max_bytes=2 << 20))
    values = ["y" * (600 << 10)] * 3 + ["s"] * 997
    sink = io.BytesIO()
    pq.write_table(pa.table({"s": values}), sink, compression="zstd", use_dictionary=False)
    result = run(sink.getvalue(), path="p.parquet", limits=PreviewLimits(max_bytes=1 << 20))
    assert result.truncated and result.rows_sampled >= 1


# ---------------------------------------------------------------- fix round 3: dictionary-expansion bombs

_BOMB_SCRIPT = """
import io, resource, sys
import pyarrow as pa, pyarrow.parquet as pq
from api.modules.catalog.previews import profile as P

entry, duplicate, mode = int(sys.argv[1]), sys.argv[2] == "dup", sys.argv[3]
lying, swap = mode == "lying", mode == "swap"
column = pa.DictionaryArray.from_arrays(pa.array([0] * 200_000, pa.int32()), pa.array(["x" * entry]))
names = ["s", "s"] if duplicate else ["s"]
arrays = [column] * len(names)
if swap:  # a plain, uncompressed binary column carries a fake 2-byte dictionary page header
    arrays.append(pa.array([b"FAKE\x15\x04\x15\x04"] * 200_000, pa.binary()))
    names = names + ["f"]
table = pa.Table.from_arrays(arrays, names=names)
sink = io.BytesIO()
pq.write_table(table, sink, store_schema=False, dictionary_pagesize_limit=256 << 20, use_dictionary=["s"],
               compression={"s": "zstd", "f": "none"})
data = sink.getvalue()
del table, column, arrays
if swap:
    # hostile footer: data_page_offset -> the real (huge) dictionary page, dictionary_page_offset -> the fake
    # header. The decoder starts at min(data, dictionary) offset, i.e. at the real dictionary page.
    import struct

    def zigzag(n):
        n, out = (n << 1) ^ (n >> 63), b""
        while n >= 0x80:
            out, n = out + bytes([n & 0x7F | 0x80]), n >> 7
        return out + bytes([n])

    buf = bytearray(data)
    fake = data.index(b"FAKE") + 4
    footer = len(buf) - 8 - struct.unpack("<i", buf[-8:-4])[0]
    for c in range(len(names) - 1):
        cm = pq.ParquetFile(io.BytesIO(bytes(buf))).metadata.row_group(0).column(c)
        dat, dic = cm.data_page_offset, cm.dictionary_page_offset
        old = b"\x26" + zigzag(dat) + b"\x26" + zigzag(dic)  # ColumnMetaData fields 9 and 11 (i64 delta 2)
        new = b"\x26" + zigzag(dic) + b"\x26" + zigzag(fake)
        assert len(old) == len(new)
        at = bytes(buf).index(old, footer)
        buf[at : at + len(old)] = new
    data = bytes(buf)
    cm = pq.ParquetFile(io.BytesIO(data)).metadata.row_group(0).column(0)
    assert cm.data_page_offset < cm.dictionary_page_offset == fake
if lying:
    P._footer_uncompressed = lambda group, leaves: 0  # a footer that claims (almost) nothing per row
before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
r = P.profile_table(lambda s, e: io.BytesIO(data[s : e + 1]), len(data), path="m.parquet", hints={},
                    limits=P.PreviewLimits(), deadline=P.make_deadline(60))
grown = (resource.getrusage(resource.RUSAGE_SELF).ru_maxrss - before) // 1024
print(r.rows_sampled, int(r.truncated), [c["kind"] for c in r.preview["columns"]][0], grown)
"""


def _bomb(
    entry: int, duplicate: bool = False, lying: bool = False, swap: bool = False
) -> tuple[int, bool, str, int]:
    import os
    import subprocess
    import sys
    import time

    env = dict(os.environ, PYTHONPATH=os.pathsep.join(p for p in sys.path if p))
    start = time.monotonic()
    args = [str(entry), "dup" if duplicate else "one", "swap" if swap else "lying" if lying else "honest"]
    out = subprocess.run(
        [sys.executable, "-c", _BOMB_SCRIPT, *args],
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=True,
    ).stdout.split()
    assert time.monotonic() - start < 30
    return int(out[0]), out[1] == "1", out[2], int(out[3])


@pytest.mark.parametrize("entry", [1_000_000, 4_000_000])
def test_dictionary_expansion_bomb_stays_bounded(entry: int) -> None:
    rows, truncated, kind, grown_mb = _bomb(entry)
    assert rows > 0 and truncated and kind == "categorical"
    assert grown_mb < 512


def test_dictionary_bomb_with_duplicate_names_is_bounded_by_page_headers() -> None:
    rows, truncated, _, grown_mb = _bomb(4_000_000, duplicate=True)
    assert rows > 0 and truncated and grown_mb < 512


@pytest.mark.parametrize("duplicate", [False, True])
def test_lying_footer_cannot_size_the_batches(duplicate: bool) -> None:
    rows, truncated, _, grown_mb = _bomb(4_000_000, duplicate=duplicate, lying=True)
    assert rows > 0 and truncated and grown_mb < 512


def test_page_header_parser() -> None:
    from api.modules.catalog.previews.profile import page_header_sizes

    # compact protocol: field 1 i32 (0x15) zigzag(2)=4, field 2 i32 (0x15) zigzag(300)=600 -> varint 0xd8 0x04
    assert page_header_sizes(bytes([0x15, 0x04, 0x15, 0xD8, 0x04, 0x15, 0x02, 0x00])) == (2, 300)
    assert page_header_sizes(b"") is None and page_header_sizes(b"\x00") is None
    assert page_header_sizes(bytes([0x18, 0x01])) is None  # not an i32 field


# ---------------------------------------------------------------- fix round 4: page header at the decoder's start


@pytest.mark.parametrize("duplicate", [False, True])
@pytest.mark.parametrize("entry", [4_000_000, 20_000_000])
def test_swapped_page_offsets_cannot_hide_the_real_dictionary(duplicate: bool, entry: int) -> None:
    # p7 (dictionary read) / p8 (densified, duplicate names): the footer points dictionary_page_offset at a fake
    # tiny header and data_page_offset at the real dictionary page, which the decoder reads first. The real page
    # is what gets sized: 4 MB fits the max_bytes // 4 dictionary budget (decoded, bounded batches; before the fix
    # the densified case grew to ~10 GB), 20 MB does not (kind "other", never decoded; before: OOM-killed).
    rows, truncated, kind, grown_mb = _bomb(entry, duplicate=duplicate, swap=True)
    assert rows > 0 and truncated
    assert kind == ("other" if entry > PreviewLimits().max_bytes // 4 else "categorical")
    assert grown_mb < 512


def _zz(n: int) -> bytes:
    n, out = (n << 1) ^ (n >> 63), b""
    while n >= 0x80:
        out, n = out + bytes([n & 0x7F | 0x80]), n >> 7
    return out + bytes([n])


def _page(page_type: int, size: int, compressed: int = 10) -> bytes:
    """A minimal complete thrift-compact PageHeader: fields 1-3 (i32) and the stop byte."""
    return b"\x15" + _zz(page_type) + b"\x15" + _zz(size) + b"\x15" + _zz(compressed) + b"\x00"


def test_dictionary_page_is_sized_at_the_decoder_start_offset() -> None:
    from types import SimpleNamespace

    from api.modules.catalog.previews.profile import _dictionary_page_size

    pages = {100: _page(2, 5_000_000), 200: _page(0, 10), 300: _page(2, 7, 7), 400: _page(0, 10)}

    def peek(offset: int, n: int) -> bytes:
        return pages.get(offset, b"\xff" * n)[:n]

    def chunk(data: int | None, dic: int | None, has: bool = True) -> SimpleNamespace:
        return SimpleNamespace(data_page_offset=data, dictionary_page_offset=dic, has_dictionary_page=has)

    assert _dictionary_page_size(chunk(200, 100), peek) == 5_000_000  # normal layout
    assert _dictionary_page_size(chunk(100, 300), peek) == 5_000_000  # swap: the decoder starts at 100
    assert _dictionary_page_size(chunk(100, 0), peek) == 5_000_000  # offset 0 is ignored by the decoder
    assert _dictionary_page_size(chunk(400, None, has=False), peek) == 0  # plain chunk without a dictionary
    assert (
        _dictionary_page_size(chunk(300, None, has=False), peek) == 7
    )  # undeclared but decoded: still sized
    assert _dictionary_page_size(chunk(400, 300), peek) == 7
    # declared dictionary, but the decoder's first page is a data page: inconsistent -> never decoded
    assert _dictionary_page_size(chunk(200, 300), peek) is None
    assert _dictionary_page_size(chunk(200, 0), peek) is None
    assert _dictionary_page_size(chunk(150, 100), peek) == 5_000_000
    assert _dictionary_page_size(chunk(150, None, has=False), peek) is None  # unreadable header
    assert _dictionary_page_size(chunk(None, None, has=False), peek) is None
    assert _dictionary_page_size(chunk(-1, None, has=False), peek) is None


def test_densified_strings_without_a_leading_dictionary_page_are_other() -> None:
    # duplicate-name strings are densified; without a leading dictionary page a later one could not be sized
    table = pa.Table.from_arrays(
        [pa.array(["a", "b"]), pa.array(["c", "d"]), pa.array(["e", "f"])], ["s", "s", "u"]
    )
    for use_dictionary, kind in ((False, "other"), (True, "categorical")):
        sink = io.BytesIO()
        pq.write_table(table, sink, use_dictionary=use_dictionary)
        result = run(sink.getvalue(), path="p.parquet")
        kinds = [c["kind"] for c in result.preview["columns"]]
        assert kinds[:2] == [kind, kind] and result.rows_sampled == 2


# ---------------------------------------------------------------- fix round 5: the whole PageHeader is parsed

_DICT_HEADER = b"\x5c\x15\x02\x15\x00\x11\x00"  # field 7 struct: num_values=1, encoding=PLAIN, is_sorted=true


def test_page_header_parser_reads_the_whole_struct() -> None:
    from api.modules.catalog.previews.profile import page_header_sizes

    head = b"\x15\x04\x15" + _zz(300) + b"\x15" + _zz(20)
    assert page_header_sizes(head + b"\x00") == (2, 300)
    # crc (field 4, delta 1), then the dictionary page header (field 7, struct, delta 3)
    assert page_header_sizes(head + b"\x15\x07" + b"\x3c" + _DICT_HEADER[1:] + b"\x00") == (2, 300)
    # a data page header (field 5) whose statistics (its field 5) hold long binary min/max values
    nested = (
        b"\x15\x00\x15"
        + _zz(5000)
        + b"\x15"
        + _zz(4000)
        + b"\x2c"  # field 5: DataPageHeader (struct, delta 2)
        + b"\x15\x02\x15\x00\x15\x06\x15\x06"  # num_values, encoding, def/rep level encodings
        + b"\x1c"  # field 5: statistics (struct, delta 1)
        + b"\x18"
        + bytes([0xE8, 0x07])
        + b"m" * 1000  # field 1: max (binary, 1000 bytes)
        + b"\x18"
        + bytes([0xE8, 0x07])
        + b"n" * 1000  # field 2: min
        + b"\x19\x23"
        + b"\x01\x02"  # field 3: a list of 2 bytes (exercises list skipping)
        + b"\x00"  # end statistics
        + b"\x00"  # end DataPageHeader
        + b"\x00"  # end PageHeader
    )
    assert page_header_sizes(nested) == (0, 5000)
    assert page_header_sizes(nested[:-1]) is None  # truncated: no stop byte
    assert page_header_sizes(nested[:600]) is None


@pytest.mark.parametrize(
    "header",
    [
        # p9: a long-form field header jumps back to field 2; the thrift decoder keeps the LAST value
        b"\x15\x04\x15\x04\x15\x04\x05\x04" + _zz(20_000_004) + b"\x00",
        # long-form header even for a new field id
        b"\x15\x04\x15\x04\x05\x06\x04\x00",
        # field 1 repeated through a long-form header
        b"\x15\x04\x15\x04\x15\x04\x05\x02\x04\x00",
        b"\x15\x04\x15\x04\x00",  # field 3 (compressed_page_size) missing
        b"\x15\x04\x16\x04\x15\x04\x00",  # field 2 is not an i32
        b"\x15\x04\x15\x04\x15\x04\x1d\x00",  # unknown wire type 13
        b"\x15\x04\x15\x03\x15\x04\x00",  # negative uncompressed size
        b"\x15\x04\x15\x04\x15\x04",  # truncated: no stop
        b"\x15\x04\x15\x04\x15\x04" + b"\x1c" * 40 + b"\x00" * 41,  # nesting deeper than the bound
    ],
)
def test_hostile_page_headers_are_rejected(header: bytes) -> None:
    from api.modules.catalog.previews.profile import page_header_sizes

    assert page_header_sizes(header) is None


def test_index_and_unknown_first_pages_are_never_decoded() -> None:
    from types import SimpleNamespace

    from api.modules.catalog.previews.profile import _dictionary_page_size

    for page_type in (1, 7):  # INDEX_PAGE (skipped by the decoder), unknown type
        for has in (False, True):
            chunk = SimpleNamespace(
                data_page_offset=100, dictionary_page_offset=None, has_dictionary_page=has
            )
            assert _dictionary_page_size(chunk, lambda o, n, t=page_type: _page(t, 10)[:n]) is None
    chunk = SimpleNamespace(data_page_offset=100, dictionary_page_offset=None, has_dictionary_page=False)
    assert _dictionary_page_size(chunk, lambda o, n: _page(3, 10)[:n]) == 0  # DATA_PAGE_V2


def test_large_page_header_is_read_with_a_second_peek() -> None:
    from types import SimpleNamespace

    from api.modules.catalog.previews.profile import _dictionary_page_size

    header = (
        b"\x15\x00\x15"
        + _zz(5000)
        + b"\x15"
        + _zz(4000)
        + b"\x2c\x15\x02\x15\x00\x15\x06\x15\x06\x1c"
        + b"\x18"
        + bytes([0xDC, 0x0B])
        + b"m" * 1500
        + b"\x18"
        + bytes([0xDC, 0x0B])
        + b"n" * 1500
        + b"\x00\x00\x00"
    )
    seen: list[int] = []

    def peek(offset: int, n: int) -> bytes:
        seen.append(n)
        return header[:n]

    chunk = SimpleNamespace(data_page_offset=4, dictionary_page_offset=None, has_dictionary_page=False)
    assert _dictionary_page_size(chunk, peek) == 0 and len(seen) == 2


_FIELD_BOMB_SCRIPT = """
import io, resource, struct, sys
import pyarrow as pa, pyarrow.parquet as pq
from api.modules.catalog.previews import profile as P

entry, duplicate = int(sys.argv[1]), sys.argv[2] == "dup"
small = pa.DictionaryArray.from_arrays(pa.array([0] * 200_000, pa.int32()), pa.array(["a"]))
big = pa.DictionaryArray.from_arrays(pa.array([0] * 200_000, pa.int32()), pa.array(["x" * entry]))
arrays, names = ([small, big], ["s", "s"]) if duplicate else ([big], ["s"])
sink = io.BytesIO()
pq.write_table(pa.Table.from_arrays(arrays, names=names), sink, store_schema=False,
               dictionary_pagesize_limit=256 << 20, compression="zstd")
data = sink.getvalue()
del arrays, small, big


def zz(n):
    n, out = (n << 1) ^ (n >> 63), b""
    while n >= 0x80:
        out, n = out + bytes([n & 0x7F | 0x80]), n >> 7
    return out + bytes([n])


# p9: in the last column's dictionary PageHeader, insert "type=2, size=2" and a long-form header that jumps back
# to field 2; the thrift decoder keeps the last value (the real size), a first-match parser sees 2
cm = pq.ParquetFile(io.BytesIO(data)).metadata.row_group(0).column(len(names) - 1)
dic, dat, total = cm.dictionary_page_offset, cm.data_page_offset, cm.total_compressed_size
assert data[dic : dic + 2] == b"\x15\x04"
ins = b"\x15\x04\x15\x04\x05\x02"
shift = len(ins) - 1
body = data[:dic] + ins + data[dic + 1 :]
start = len(data) - 8 - struct.unpack("<i", data[-8:-4])[0]
footer = data[start : len(data) - 8]
old = b"\x16" + zz(total) + b"\x26" + zz(dat) + b"\x26" + zz(dic)
assert footer.count(old) == 1
footer = footer.replace(old, b"\x16" + zz(total + shift) + b"\x26" + zz(dat + shift) + b"\x26" + zz(dic))
data = body[: start + shift] + footer + struct.pack("<i", len(footer)) + b"PAR1"
before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
r = P.profile_table(lambda s, e: io.BytesIO(data[s : e + 1]), len(data), path="m.parquet", hints={},
                    limits=P.PreviewLimits(), deadline=P.make_deadline(60))
grown = (resource.getrusage(resource.RUSAGE_SELF).ru_maxrss - before) // 1024
print(r.rows_sampled, int(r.truncated), ",".join(c["kind"] for c in r.preview["columns"]), grown)
"""


@pytest.mark.parametrize("duplicate", [False, True])
def test_repeated_size_field_cannot_hide_the_real_dictionary(duplicate: bool) -> None:
    import os
    import subprocess
    import sys

    env = dict(os.environ, PYTHONPATH=os.pathsep.join(p for p in sys.path if p))
    out = subprocess.run(
        [
            "prlimit",
            "--as=8589934592",
            sys.executable,
            "-c",
            _FIELD_BOMB_SCRIPT,
            "20000000",
            "dup" if duplicate else "one",
        ],
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=True,
    ).stdout.split()
    rows, truncated, kinds, grown_mb = int(out[0]), out[1] == "1", out[2].split(","), int(out[3])
    assert rows > 0 and truncated
    assert kinds == (["categorical", "other"] if duplicate else ["other"])
    assert grown_mb < 512


def test_real_plain_page_with_large_statistics_is_still_decoded() -> None:
    # pyarrow writes min/max statistics into each data page header: a 3,000-char PLAIN string column has a
    # header far over the first 256-byte peek, read by the second peek
    values = ["a" * 3000, "b" * 3000]
    sink = io.BytesIO()
    pq.write_table(pa.table({"s": values, "n": [1, 2]}), sink, use_dictionary=False, compression="zstd")
    data = sink.getvalue()
    cm = pq.ParquetFile(io.BytesIO(data)).metadata.row_group(0).column(0)
    assert cm.statistics is not None and not cm.has_dictionary_page
    result = run(data, path="p.parquet")
    assert result.rows_sampled == 2
    assert [c["kind"] for c in result.preview["columns"]][1] == "numeric"
    assert result.preview["rows"][0][0] is not None


def test_uncompressed_page_is_sized_by_the_larger_of_both_sizes() -> None:
    # for UNCOMPRESSED chunks pyarrow reads compressed_page_size (field 3) bytes and ignores field 2
    from api.modules.catalog.previews.profile import page_header_sizes

    assert page_header_sizes(_page(2, 8, 20_000_004)) == (2, 20_000_004)
    assert page_header_sizes(_page(2, 20_000_004, 8)) == (2, 20_000_004)


@pytest.mark.parametrize(
    "header",
    [b"\x15\x04\x39" + b"\x19" * n for n in (9, 100, 2_000, 60_000)]
    + [b"\x15\x04\x3a" + b"\x1a" * 2_000, b"\x15\x04\x3b" + b"\x01\xbb" * 30_000],
    ids=["list9", "list100", "list2000", "list60000", "set2000", "map30000"],
)
def test_nested_collections_are_depth_bounded_and_never_raise(header: bytes) -> None:
    from api.modules.catalog.previews.profile import _peek_page_header, page_header_sizes

    assert page_header_sizes(header) is None
    padded = header + b"\x00" * 70_000
    assert _peek_page_header(lambda o, n: padded[o : o + n], 0) is None


def test_recursion_error_never_escapes_the_parser(monkeypatch: pytest.MonkeyPatch) -> None:
    from api.modules.catalog.previews import profile as P

    def boom(self, wire, depth):  # type: ignore[no-untyped-def]
        raise RecursionError

    monkeypatch.setattr(P._ThriftCompact, "value", boom)
    header = b"\x15\x04\x15\x04\x15\x04\x19\x00\x00"
    assert P.page_header_sizes(header) is None
    assert P._peek_page_header(lambda o, n: header[o : o + n], 0) is None


_UNCOMPRESSED_BOMB_SCRIPT = """
import io, resource, struct, sys
import pyarrow as pa, pyarrow.parquet as pq
from api.modules.catalog.previews import profile as P

entry = int(sys.argv[1])
d = pa.DictionaryArray.from_arrays(pa.array([0] * 200_000, pa.int32()), pa.array(["x" * entry]))
sink = io.BytesIO()
pq.write_table(pa.Table.from_arrays([d, d], names=["s", "s"]), sink, store_schema=False,
               dictionary_pagesize_limit=256 << 20, compression="none")
data = sink.getvalue()
del d


def zz(n):
    n, out = (n << 1) ^ (n >> 63), b""
    while n >= 0x80:
        out, n = out + bytes([n & 0x7F | 0x80]), n >> 7
    return out + bytes([n])


# r5 small2: the second column's UNCOMPRESSED dictionary page declares uncompressed_page_size = 8 while
# compressed_page_size stays real; pyarrow reads field 3 bytes for UNCOMPRESSED chunks
cm = pq.ParquetFile(io.BytesIO(data)).metadata.row_group(0).column(1)
dic, dat, total = cm.dictionary_page_offset, cm.data_page_offset, cm.total_compressed_size
size = entry + 4
old = b"\\x15\\x04\\x15" + zz(size) + b"\\x15" + zz(size)
assert data[dic : dic + len(old)] == old
new = b"\\x15\\x04\\x15" + zz(8) + b"\\x15" + zz(size)
shift = len(new) - len(old)
body = data[:dic] + new + data[dic + len(old) :]
start = len(data) - 8 - struct.unpack("<i", data[-8:-4])[0]
footer = data[start : len(data) - 8]
old_f = b"\\x16" + zz(total) + b"\\x26" + zz(dat) + b"\\x26" + zz(dic)
assert footer.count(old_f) == 1
footer = footer.replace(old_f, b"\\x16" + zz(total + shift) + b"\\x26" + zz(dat + shift) + b"\\x26" + zz(dic))
data = body[: start + shift] + footer + struct.pack("<i", len(footer)) + b"PAR1"
before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
r = P.profile_table(lambda s, e: io.BytesIO(data[s : e + 1]), len(data), path="m.parquet", hints={},
                    limits=P.PreviewLimits(), deadline=P.make_deadline(60))
grown = (resource.getrusage(resource.RUSAGE_SELF).ru_maxrss - before) // 1024
print(r.rows_sampled, int(r.truncated), ",".join(c["kind"] for c in r.preview["columns"]), grown)
"""


@pytest.mark.parametrize("entry", [4_000_000, 20_000_000])
def test_uncompressed_dictionary_with_tiny_declared_size_stays_bounded(entry: int) -> None:
    import os
    import subprocess
    import sys

    env = dict(os.environ, PYTHONPATH=os.pathsep.join(p for p in sys.path if p))
    out = subprocess.run(
        ["prlimit", "--as=8589934592", sys.executable, "-c", _UNCOMPRESSED_BOMB_SCRIPT, str(entry)],
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=True,
    ).stdout.split()
    rows, truncated, kinds, grown_mb = int(out[0]), out[1] == "1", out[2].split(","), int(out[3])
    assert rows > 0 and truncated
    if entry > PreviewLimits().max_bytes // 4:
        assert kinds == ["other", "other"]
    assert grown_mb < 512
