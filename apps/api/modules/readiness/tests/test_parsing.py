import io
import itertools
import re
import time
import tracemalloc
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from api.modules.readiness.engine import parsing
from api.modules.readiness.engine.parsing import (
    ColumnPlan,
    FilePlan,
    FileStats,
    FileTimeout,
    FileTooLarge,
    RangeReader,
    is_valid_value,
    open_parquet_range,
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


# ------------------------------------------------------------------ fix round 1 (M05-R8): hostile files


_OLD_NUMBER = re.compile(r"[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?")


def test_number_language_is_unchanged() -> None:
    for n in range(0, 7):
        for chars in itertools.product("01.+-eE", repeat=n):
            value = "".join(chars)
            assert is_valid_value("number", value) is (_OLD_NUMBER.fullmatch(value) is not None), value


@pytest.mark.parametrize("declared", ["integer", "number", "date", "datetime", "boolean"])
def test_hostile_long_values_are_rejected_fast(declared: str) -> None:
    started = time.perf_counter()
    assert is_valid_value(declared, "9" * 100_000 + "x") is False
    assert is_valid_value(declared, "1" * 600) is False  # over the value-length cap
    assert time.perf_counter() - started < 0.5


def test_blank_lines_honor_the_deadline() -> None:
    calls = 0

    def expiring() -> None:
        nonlocal calls
        calls += 1
        if calls > 50:
            raise FileTimeout()

    started = time.perf_counter()
    with pytest.raises(FileTimeout):
        profile_csv(
            io.BytesIO(b"a\n" + b"\n" * 2_000_000),
            path="d.csv",
            delimiter=",",
            plan=FilePlan(),
            max_rows=10,
            max_bytes=1 << 28,
            deadline=expiring,
        )
    assert time.perf_counter() - started < 1.0


def test_blank_lines_stop_at_the_byte_limit() -> None:
    started = time.perf_counter()
    stats = _csv(b"a,b\n" + b"\n" * 2_000_000, max_bytes=1000)
    assert stats.truncated is True and stats.sampled_rows == 0
    assert time.perf_counter() - started < 1.0


def test_oversized_field_rows_stop_at_the_row_limit() -> None:
    data = b"a\n" + (b"x" * 200_000 + b"\n") * 50
    stats = _csv(data, max_rows=1)
    assert (stats.truncated, stats.rows_read, stats.malformed_rows) == (True, 1, 1)


def _peak_over_baseline(data: bytes) -> tuple[FileStats, int]:
    stream = io.BytesIO(data)
    tracemalloc.start()
    try:
        stats = _csv_stream(stream)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    return stats, peak


def _csv_stream(stream: io.BytesIO) -> FileStats:
    return profile_csv(
        stream,
        path="d.csv",
        delimiter=",",
        plan=FilePlan(),
        max_rows=100_000,
        max_bytes=1 << 28,
        deadline=no_deadline,
    )


def test_newline_free_body_is_bounded() -> None:
    stats, peak = _peak_over_baseline(b"a\n" + b"x" * 20_000_000)
    assert stats.encoding_error is True
    assert peak < 8 << 20


def test_newline_free_header_is_bounded() -> None:
    stats, peak = _peak_over_baseline(b"x" * 20_000_000)
    assert stats.encoding_error is True
    assert peak < 8 << 20


def test_unterminated_quote_is_bounded() -> None:
    stats, peak = _peak_over_baseline(b'a\n"' + b"xxxxxxxxx\n" * 2_000_000)
    assert peak < 8 << 20
    assert stats.truncated or stats.malformed_rows > 0


def test_single_column_blank_line_is_an_empty_cell() -> None:
    stats = _csv(b"a\n1\n\n2\n", FilePlan(columns={"a": ColumnPlan("integer")}))
    assert (stats.sampled_rows, stats.columns["a"].missing) == (3, 1)


def test_blank_first_line_is_a_header_error() -> None:
    stats = _csv(b"\na,b\n1,2\n")
    assert stats.header_error is True and stats.sampled_rows == 0 and stats.header == ()
    assert _csv(b"a,b\n1,2\n").header_error is False


class _Ranges:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.requests: list[tuple[int, int]] = []

    def __call__(self, start: int, end: int) -> io.BytesIO:
        self.requests.append((start, end))
        return io.BytesIO(self.data[start : end + 1])


def test_range_reader_caps_every_read_and_checks_the_deadline() -> None:
    data = bytes(range(256)) * 100
    ranges = _Ranges(data)
    ticks = 0

    def deadline() -> None:
        nonlocal ticks
        ticks += 1

    reader = RangeReader(ranges, len(data), deadline=deadline, max_read=1000)
    reader.seek(500)
    buf = bytearray(10_000)
    assert reader.readinto(buf) == 1000
    assert bytes(buf[:1000]) == data[500:1500]
    reader.seek(-10, io.SEEK_END)
    assert reader.read(100) == data[-10:]
    assert all(end - start + 1 <= 1000 for start, end in ranges.requests)
    assert ticks == 2


def test_parquet_through_range_reader_matches_in_memory() -> None:
    table = pa.table({"n": pa.array(range(50), pa.int64())})
    data = _parquet(table).getvalue()
    ranges = _Ranges(data)
    stats = profile_parquet(
        open_parquet_range(ranges, len(data), deadline=no_deadline, max_read=256),
        path="t.parquet",
        plan=FilePlan(),
        max_rows=100,
        max_bytes=1 << 20,
        deadline=no_deadline,
    )
    assert stats.sampled_rows == 50 and stats.truncated is False
    assert max(end - start + 1 for start, end in ranges.requests) <= 1 << 20


class _Plain(io.RawIOBase):
    """Non-seekable stream."""

    def __init__(self, data: bytes) -> None:
        self._inner = io.BytesIO(data)

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return False

    def readinto(self, b: Any) -> int:
        return self._inner.readinto(b)


def test_non_seekable_stream_over_the_cap_fails_cleanly(monkeypatch: pytest.MonkeyPatch) -> None:
    created: list[Any] = []
    real = parsing.tempfile.SpooledTemporaryFile

    def recording(*args: Any, **kwargs: Any) -> Any:
        spool = real(*args, **kwargs)
        created.append(spool)
        return spool

    monkeypatch.setattr(parsing.tempfile, "SpooledTemporaryFile", recording)
    with pytest.raises(FileTooLarge):
        profile_parquet(
            _Plain(b"x" * 5000),  # type: ignore[arg-type]
            path="t.parquet",
            plan=FilePlan(),
            max_rows=10,
            max_bytes=100,
            deadline=no_deadline,
            max_spool_bytes=1000,
        )
    assert created and all(s.closed for s in created)


def test_spool_is_closed_on_deadline_and_on_success(monkeypatch: pytest.MonkeyPatch) -> None:
    created: list[Any] = []
    real = parsing.tempfile.SpooledTemporaryFile

    def recording(*args: Any, **kwargs: Any) -> Any:
        spool = real(*args, **kwargs)
        created.append(spool)
        return spool

    monkeypatch.setattr(parsing.tempfile, "SpooledTemporaryFile", recording)

    def expired() -> None:
        raise FileTimeout()

    data = _parquet(pa.table({"n": pa.array(range(10), pa.int32())})).getvalue()
    with pytest.raises(FileTimeout):
        profile_parquet(
            _Plain(data),  # type: ignore[arg-type]
            path="t.parquet",
            plan=FilePlan(),
            max_rows=10,
            max_bytes=1 << 20,
            deadline=expired,
        )
    stats = profile_parquet(
        _Plain(data),  # type: ignore[arg-type]
        path="t.parquet",
        plan=FilePlan(),
        max_rows=10,
        max_bytes=1 << 20,
        deadline=no_deadline,
    )
    assert stats.sampled_rows == 10
    assert len(created) == 2 and all(s.closed for s in created)


def test_storage_errors_are_not_masked_as_encoding_errors() -> None:
    data = _parquet(pa.table({"n": pa.array(range(10), pa.int32())})).getvalue()

    class Failing(io.BytesIO):
        def __init__(self) -> None:
            super().__init__(data)
            self.armed = False

        def read(self, size: int | None = -1) -> bytes:
            if self.tell() < len(data) - 200:  # footer reads succeed, column data fails
                raise TimeoutError("storage timeout")
            return super().read(size)

        def readinto(self, b: Any) -> int:
            if self.tell() < len(data) - 200:
                raise TimeoutError("storage timeout")
            return super().readinto(b)

    with pytest.raises(TimeoutError):
        profile_parquet(
            Failing(), path="t.parquet", plan=FilePlan(), max_rows=10, max_bytes=1 << 20, deadline=no_deadline
        )


def test_corrupt_row_group_is_an_encoding_error_with_partial_stats() -> None:
    table = pa.table({"n": pa.array(range(3000), pa.int64())})
    sink = io.BytesIO()
    pq.write_table(table, sink, row_group_size=1500, compression="none")
    data = bytearray(sink.getvalue())
    # Corrupt the data of the last row group (column chunk bytes just before the footer).
    footer_len = int.from_bytes(data[-8:-4], "little")
    end = len(data) - 8 - footer_len
    for i in range(end - 40, end):
        data[i] = 0xFF
    stats = profile_parquet(
        io.BytesIO(bytes(data)),
        path="t.parquet",
        plan=FilePlan(),
        max_rows=100_000,
        max_bytes=1 << 20,
        deadline=no_deadline,
    )
    assert stats.encoding_error is True
    assert 0 < stats.sampled_rows < 3000


def test_parquet_batches_are_small_and_max_rows_zero_is_safe() -> None:
    table = pa.table({"n": pa.array(range(5000), pa.int64())})
    sink = io.BytesIO()
    pq.write_table(table, sink, row_group_size=5000)
    sink.seek(0)
    stats = profile_parquet(
        sink, path="t.parquet", plan=FilePlan(), max_rows=100_000, max_bytes=8000, deadline=no_deadline
    )
    assert stats.truncated is True and stats.sampled_rows < 5000  # stopped by bytes within one row group
    zero = profile_parquet(
        _parquet(table), path="t.parquet", plan=FilePlan(), max_rows=0, max_bytes=100, deadline=no_deadline
    )
    assert (zero.sampled_rows, zero.truncated) == (0, True)


def test_parquet_duplicate_column_names_are_reported() -> None:
    table = pa.Table.from_arrays(
        [pa.array([1, 2]), pa.array([3, 4]), pa.array([5, 6])], names=["a", "b", "a"]
    )
    stats = profile_parquet(
        _parquet(table),
        path="t.parquet",
        plan=FilePlan(),
        max_rows=10,
        max_bytes=1 << 20,
        deadline=no_deadline,
    )
    assert stats.header == ("a", "b", "a") and stats.duplicate_columns == ["a"]
    assert stats.sampled_rows == 2
