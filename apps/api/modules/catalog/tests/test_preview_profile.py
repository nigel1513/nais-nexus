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
    assert page_header_sizes(bytes([0x15, 0x04, 0x15, 0xD8, 0x04, 0x15, 0x02])) == (2, 300)
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


def _page(page_type: int, size: int) -> bytes:
    def zz(n: int) -> bytes:
        n, out = n << 1, b""
        while n >= 0x80:
            out, n = out + bytes([n & 0x7F | 0x80]), n >> 7
        return out + bytes([n])

    return bytes([0x15]) + zz(page_type) + bytes([0x15]) + zz(size)


def test_dictionary_page_is_sized_at_the_decoder_start_offset() -> None:
    from types import SimpleNamespace

    from api.modules.catalog.previews.profile import _dictionary_page_size

    pages = {100: _page(2, 5_000_000), 200: _page(0, 10), 300: _page(2, 7), 400: _page(0, 10)}

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
