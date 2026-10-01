import io

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from api.modules.readiness.engine.parsing import (
    ColumnPlan,
    FilePlan,
    FileStats,
    FileTimeout,
    is_valid_value,
    profile_csv,
    profile_parquet,
)


def no_deadline() -> None:
    return None


def _csv(
    data: bytes, plan: FilePlan | None = None, max_rows: int = 100_000, max_bytes: int = 1 << 28
) -> FileStats:
    return profile_csv(
        io.BytesIO(data),
        path="d.csv",
        delimiter=",",
        plan=plan or FilePlan(),
        max_rows=max_rows,
        max_bytes=max_bytes,
        deadline=no_deadline,
    )


@pytest.mark.parametrize(
    ("declared", "value", "ok"),
    [
        ("integer", "+42", True),
        ("integer", "4.0", False),
        ("integer", "٣", False),  # non-ASCII digit
        ("number", "1e-3", True),
        ("number", ".5", True),
        ("number", "5.", True),
        ("number", "NaN", False),
        ("number", "Infinity", False),
        ("number", "1,5", False),
        ("boolean", "TRUE", True),
        ("boolean", "yes", False),
        ("date", "2026-02-28", True),
        ("date", "2026-02-30", False),
        ("datetime", "2026-01-01T00:01:00Z", True),
        ("datetime", "2026-01-01T00:01:00.5+09:00", True),
        ("datetime", "2026-01-01T00:01:00", False),  # offset required
        ("datetime", "2026-01-01T24:00:00Z", False),
        ("string", "anything", True),
    ],
)
def test_type_rules(declared: str, value: str, ok: bool) -> None:
    assert is_valid_value(declared, value) is ok


def test_csv_counts_missing_invalid_and_first_rows() -> None:
    plan = FilePlan(missing_tokens=frozenset({"", "NA"}), columns={"n": ColumnPlan("integer")})
    rows = [f"r{i},{'x' if i in (3, 7) else ('NA' if i == 5 else i)}\n" for i in range(1, 11)]
    stats = _csv(("id,n\n" + "".join(rows)).encode(), plan)
    assert stats.header == ("id", "n")
    assert (stats.sampled_rows, stats.malformed_rows, stats.truncated, stats.encoding_error) == (
        10,
        0,
        False,
        False,
    )
    n = stats.columns["n"]
    assert (n.missing, n.checked, n.invalid, n.first_invalid_rows) == (1, 9, 2, [3, 7])
    assert stats.columns["id"].checked == 0  # undeclared column: missing counted, no type check


def test_csv_bom_quotes_and_blank_lines() -> None:
    stats = _csv('﻿a,b\n"x, y",1\n\n"multi\nline",2\n'.encode())
    assert stats.header == ("a", "b")
    assert stats.sampled_rows == 2


def test_csv_malformed_rows_are_counted_and_excluded() -> None:
    stats = _csv(b"a,b\n1,2\n1,2,3\n4\n5,x\n", FilePlan(columns={"b": ColumnPlan("integer")}))
    assert (stats.rows_read, stats.sampled_rows, stats.malformed_rows) == (4, 2, 2)
    assert stats.columns["b"].invalid == 1
    assert stats.columns["b"].first_invalid_rows == [4]  # row numbers count malformed rows too


def test_csv_encoding_error_stops_parsing() -> None:
    assert _csv(b"a,b\n1,2\n\xff\xfe,3\n").encoding_error is True


def test_csv_row_limit_sets_truncated_only_when_more_rows_exist() -> None:
    data = b"a\n" + b"".join(b"%d\n" % i for i in range(10))
    assert _csv(data, max_rows=10).truncated is False
    limited = _csv(data, max_rows=4)
    assert (limited.sampled_rows, limited.truncated) == (4, True)


def test_csv_byte_limit_truncates() -> None:
    data = b"a\n" + b"".join(b"%06d\n" % i for i in range(1000))
    stats = _csv(data, max_bytes=70)  # 6 value bytes + 1 separator per row
    assert (stats.sampled_rows, stats.truncated) == (10, True)


def test_csv_codebook_codes() -> None:
    stats = _csv(b"m\nAL\nFE\nCU\nZN\n\n", FilePlan(columns={"m": ColumnPlan(codes=frozenset({"AL", "CU"}))}))
    assert stats.columns["m"].undefined_codes == 2


def test_csv_duplicate_header_columns_are_reported() -> None:
    assert _csv(b"a,b,a\n1,2,3\n").duplicate_columns == ["a"]


def test_empty_file_has_no_header() -> None:
    stats = _csv(b"")
    assert stats.header == () and stats.sampled_rows == 0


def test_deadline_aborts_parsing() -> None:
    def expired() -> None:
        raise FileTimeout()

    with pytest.raises(FileTimeout):
        profile_csv(
            io.BytesIO(b"a\n" + b"1\n" * 5000),
            path="d.csv",
            delimiter=",",
            plan=FilePlan(),
            max_rows=10_000,
            max_bytes=1 << 20,
            deadline=expired,
        )


def _parquet(table: pa.Table) -> io.BytesIO:
    sink = io.BytesIO()
    pq.write_table(table, sink, row_group_size=3)
    sink.seek(0)
    return sink


def test_parquet_types_nulls_and_compatibility() -> None:
    table = pa.table({"n": pa.array([1, None, 3, 4], pa.int64()), "s": pa.array(["a", "b", None, "d"])})
    plan = FilePlan(columns={"n": ColumnPlan("integer"), "s": ColumnPlan("number")})
    stats = profile_parquet(
        _parquet(table), path="t.parquet", plan=plan, max_rows=100, max_bytes=1 << 20, deadline=no_deadline
    )
    assert stats.header == ("n", "s")
    assert stats.parquet_numeric == ("n",)
    assert (stats.columns["n"].missing, stats.columns["n"].invalid) == (1, 0)
    s = stats.columns["s"]
    assert (s.missing, s.invalid, s.checked, s.first_invalid_rows) == (1, 3, 3, [1, 2, 4])


def test_parquet_row_limit_truncates() -> None:
    table = pa.table({"n": pa.array(range(10), pa.int32())})
    stats = profile_parquet(
        _parquet(table),
        path="t.parquet",
        plan=FilePlan(),
        max_rows=4,
        max_bytes=1 << 20,
        deadline=no_deadline,
    )
    assert (stats.sampled_rows, stats.truncated) == (4, True)


def test_not_a_parquet_file_is_an_encoding_error() -> None:
    stats = profile_parquet(
        io.BytesIO(b"nope"),
        path="t.parquet",
        plan=FilePlan(),
        max_rows=4,
        max_bytes=100,
        deadline=no_deadline,
    )
    assert stats.encoding_error is True
