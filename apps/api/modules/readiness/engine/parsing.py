"""One streaming pass per tabular file -> per-column statistics (09 §1.4). Never keeps cell values.

CSV: stdlib csv, every value a str, fixed delimiter by extension, UTF-8 (BOM allowed). Parquet: pyarrow
iter_batches in row-group order. Sample = first `sample_max_rows` data rows within `sample_max_bytes`.
"""

import csv
import errno
import io
import re
import tempfile
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date
from typing import IO, Any, BinaryIO

DEFAULT_MISSING = frozenset({"", "NA", "N/A", "null", "NULL", "NaN"})
FIRST_ROWS_LIMIT = 10
MAX_LINE_BYTES = 1 << 20  # one physical CSV line; longer => the file is not parseable (encoding_error)
READ_CHUNK = 1 << 16  # every single read of a stream is at most this
PARQUET_BATCH_ROWS = 1024
DEFAULT_MAX_SPOOL_BYTES = 1 << 30

_INTEGER = re.compile(r"[+-]?[0-9]+")
_NUMBER = re.compile(r"[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?")  # unambiguous: no backtracking
_BOOLEAN = frozenset({"true", "false", "True", "False", "TRUE", "FALSE", "1", "0"})
_DATE = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})")
_DATETIME = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?"
    r"([Zz]|[+-]([0-9]{2}):([0-9]{2}))"
)


class FileTooLarge(Exception):
    """A non-seekable parquet stream exceeded the spool cap: the file cannot be profiled."""


class FileTimeout(Exception):
    """Parsing one file exceeded READINESS_FILE_TIMEOUT_SECONDS: the run fails with FILE_TIMEOUT."""


Deadline = Callable[[], None]  # raises FileTimeout when the per-file budget is spent


def _real_date(y: str, m: str, d: str) -> bool:
    try:
        date(int(y), int(m), int(d))
    except ValueError:
        return False
    return True


def is_valid_value(declared_type: str, value: str) -> bool:
    """09 §3.3 type rules on a non-missing CSV string (ASCII digits only)."""
    if declared_type == "integer":
        return _INTEGER.fullmatch(value) is not None
    if declared_type == "number":
        return _NUMBER.fullmatch(value) is not None
    if declared_type == "boolean":
        return value in _BOOLEAN
    if declared_type == "date":
        match = _DATE.fullmatch(value)
        return match is not None and _real_date(*match.groups())
    if declared_type == "datetime":
        match = _DATETIME.fullmatch(value)
        if match is None or not _real_date(*match.group(1, 2, 3)):
            return False
        hour, minute, second = int(match.group(4)), int(match.group(5)), int(match.group(6))
        offset_ok = match.group(9) is None or (int(match.group(9)) < 24 and int(match.group(10)) < 60)
        return hour < 24 and minute < 60 and second <= 60 and offset_ok
    return True  # string


@dataclass(frozen=True)
class ColumnPlan:
    declared_type: str | None = None  # None: not described by _schema.json -> no type check
    codes: frozenset[str] | None = None  # codebook codes for this field, if any


@dataclass(frozen=True)
class FilePlan:
    missing_tokens: frozenset[str] = DEFAULT_MISSING
    columns: dict[str, ColumnPlan] = field(default_factory=dict)


@dataclass
class ColumnStats:
    missing: int = 0
    checked: int = 0
    invalid: int = 0
    first_invalid_rows: list[int] = field(default_factory=list)
    undefined_codes: int = 0


@dataclass
class FileStats:
    path: str
    header: tuple[str, ...] = ()
    sampled_rows: int = 0  # well-formed data rows in the sample
    rows_read: int = 0  # data rows in the sample incl. malformed
    truncated: bool = False
    malformed_rows: int = 0
    encoding_error: bool = False
    header_error: bool = False  # CSV: first line blank or unreadable (09 §1.4 header required)
    columns: dict[str, ColumnStats] = field(default_factory=dict)
    parquet_types: dict[str, str] | None = None  # column -> arrow type string (parquet only)
    parquet_numeric: tuple[str, ...] = ()  # parquet columns of integer/floating/decimal type

    @property
    def duplicate_columns(self) -> list[str]:
        return sorted(name for name, count in Counter(self.header).items() if count > 1)


def _record(stats: ColumnStats, plan: ColumnPlan | None, value: str, row_number: int, missing: bool) -> None:
    if missing:
        stats.missing += 1
        return
    if plan is None:
        return
    if plan.declared_type is not None:
        stats.checked += 1
        if not is_valid_value(plan.declared_type, value):
            stats.invalid += 1
            if len(stats.first_invalid_rows) < FIRST_ROWS_LIMIT:
                stats.first_invalid_rows.append(row_number)
    if plan.codes is not None and value not in plan.codes:
        stats.undefined_codes += 1


class _Raw(io.RawIOBase):
    """Binary source for the CSV text layer: every read is capped and checks the deadline."""

    def __init__(self, source: BinaryIO, deadline: Deadline) -> None:
        self._source = source
        self._deadline = deadline
        self.failure: BaseException | None = None

    def readable(self) -> bool:
        return True

    def readinto(self, b: Any) -> int:
        self._deadline()
        try:
            chunk = self._source.read(min(len(b), READ_CHUNK))
        except Exception as exc:
            self.failure = exc
            raise
        n = len(chunk)
        b[:n] = chunk
        return n


class _Lines:
    """Bounded physical-line iterator for csv.reader; counts the bytes of every line it hands out."""

    def __init__(self, text: io.TextIOWrapper, cap: int) -> None:
        self._text = text
        self._cap = cap
        self.bytes = 0
        self.overflow = False

    def __iter__(self) -> "_Lines":
        return self

    def __next__(self) -> str:
        line = self._text.readline(self._cap + 1)
        if not line:
            raise StopIteration
        if len(line) > self._cap:
            self.overflow = True
            raise StopIteration
        self.bytes += len(line.encode("utf-8"))
        return line


def profile_csv(
    stream: BinaryIO,
    *,
    path: str,
    delimiter: str,
    plan: FilePlan,
    max_rows: int,
    max_bytes: int,
    deadline: Deadline,
) -> FileStats:
    """Limits and the deadline are checked on every line (blank and malformed lines included).

    A physical line longer than min(max_bytes, 1 MiB) makes the file unparseable: `encoding_error`.
    """
    stats = FileStats(path=path)
    text = io.TextIOWrapper(io.BufferedReader(_Raw(stream, deadline)), encoding="utf-8-sig", newline="")
    lines = _Lines(text, max(1, min(max_bytes, MAX_LINE_BYTES)))
    reader = csv.reader(lines, delimiter=delimiter, quotechar='"')
    try:
        deadline()
        try:
            header = next(reader)
        except StopIteration:
            stats.encoding_error = lines.overflow
            return stats
        except csv.Error:
            stats.header_error = True
            return stats
        if lines.overflow:
            stats.encoding_error = True
            return stats
        if not header:  # blank first line: the header is required on line 1
            stats.header_error = True
            return stats
        stats.header = tuple(header)
        index: dict[str, int] = {}
        for i, name in enumerate(header):
            index.setdefault(name, i)
        stats.columns = {name: ColumnStats() for name in index}
        slots = [(name, i, plan.columns.get(name)) for name, i in index.items()]
        width = len(header)
        lines.bytes = 0  # the byte budget covers data lines only
        prev = 0
        while True:
            deadline()
            row: list[str] | None
            try:
                row = next(reader)
            except StopIteration:
                stats.encoding_error = lines.overflow
                break
            except csv.Error:
                row = None  # e.g. field larger than the csv field limit
            if lines.overflow:
                stats.encoding_error = True
                break
            if row == [] and width == 1:
                row = [""]  # single column: a blank line is one empty cell
            before, prev = prev, lines.bytes
            if before >= max_bytes or (row != [] and stats.rows_read >= max_rows):
                stats.truncated = True
                break
            if row is None:
                stats.rows_read += 1
                stats.malformed_rows += 1
                continue
            if not row:
                continue  # blank line (multi-column): not a data row
            stats.rows_read += 1
            if len(row) != width:
                stats.malformed_rows += 1
                continue
            stats.sampled_rows += 1
            for name, i, col_plan in slots:
                value = row[i]
                _record(stats.columns[name], col_plan, value, stats.rows_read, value in plan.missing_tokens)
    except UnicodeDecodeError:
        stats.encoding_error = True
    finally:
        text.detach()
    return stats


# ---------------------------------------------------------------- parquet


class RangeReader(io.RawIOBase):
    """Seekable read-only view over a ranged source (`CatalogReadPort.open_stream(file, byte_range=...)`).

    `open_range(start, end)` returns a stream of the inclusive byte range. Every single read is capped at
    `max_read` bytes and checks the deadline, so a parquet file is never pulled whole.
    """

    def __init__(
        self,
        open_range: Callable[[int, int], BinaryIO],
        size: int,
        *,
        deadline: Deadline,
        max_read: int = 1 << 20,
    ) -> None:
        self._open_range = open_range
        self._size = size
        self._deadline = deadline
        self._max_read = max_read
        self._pos = 0
        self.failure: BaseException | None = None

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._pos

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        if whence not in (io.SEEK_SET, io.SEEK_CUR, io.SEEK_END):
            raise ValueError(f"invalid whence: {whence}")
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self._pos, io.SEEK_END: self._size}[whence]
        if base + offset < 0:
            raise ValueError("negative seek position")
        self._pos = base + offset
        return self._pos

    def readinto(self, b: Any) -> int:
        n = min(len(b), self._max_read, self._size - self._pos)
        if n <= 0:
            return 0
        self._deadline()
        try:
            source = self._open_range(self._pos, self._pos + n - 1)
            try:
                data = source.read(n)
            finally:
                source.close()
            if not data:  # the object ended before its recorded size
                raise OSError(errno.EIO, "short read: range returned no bytes before end of file")
        except Exception as exc:
            self.failure = exc
            raise
        got = len(data[:n])
        b[:got] = data[:got]
        self._pos += got
        return got


def open_parquet_range(
    open_range: Callable[[int, int], BinaryIO], size: int, *, deadline: Deadline, max_read: int = 1 << 20
) -> BinaryIO:
    """Buffered RangeReader, ready for profile_parquet."""
    reader = RangeReader(open_range, size, deadline=deadline, max_read=max_read)
    return io.BufferedReader(reader, buffer_size=max_read)


def _arrow_compatible(declared_type: str, arrow_type: Any) -> bool:
    import pyarrow as pa

    t = pa.types
    if declared_type == "string":
        return True
    if declared_type == "integer":
        return bool(t.is_integer(arrow_type))
    if declared_type == "number":
        return bool(t.is_integer(arrow_type) or t.is_floating(arrow_type) or t.is_decimal(arrow_type))
    if declared_type == "boolean":
        return bool(t.is_boolean(arrow_type))
    if declared_type == "date":
        return bool(t.is_date(arrow_type))
    if declared_type == "datetime":
        return bool(t.is_timestamp(arrow_type))
    return False


def is_numeric_arrow_type(arrow_type: Any) -> bool:
    import pyarrow as pa

    t = pa.types
    return bool(t.is_integer(arrow_type) or t.is_floating(arrow_type) or t.is_decimal(arrow_type))


def _is_corrupt(exc: Exception) -> bool:
    """Genuinely undecodable parquet content. Storage/network/OS errors are NOT corruption."""
    import pyarrow as pa

    if isinstance(exc, pa.ArrowInvalid | pa.ArrowNotImplementedError):
        return True
    # Source failures were already re-raised by the guard; a bare OSError (no errno) here is pyarrow's
    # report about bytes that were read successfully.
    return type(exc) is OSError and exc.errno is None


class _Guard(io.RawIOBase):
    """Wraps the parquet source: any exception the source raises is recorded and later re-raised as such,
    so a storage failure can never be mistaken for corrupt content."""

    def __init__(self, source: Any) -> None:
        self._source = source
        self.failure: BaseException | None = None

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        try:
            return int(self._source.tell())
        except Exception as exc:
            self.failure = exc
            raise

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        try:
            return int(self._source.seek(offset, whence))
        except Exception as exc:
            self.failure = exc
            raise

    def readinto(self, b: Any) -> int:
        try:
            chunk = self._source.read(len(b))
        except Exception as exc:
            self.failure = exc
            raise
        n = len(chunk)
        b[:n] = chunk
        return n


def _spool(stream: BinaryIO, cap: int, deadline: Deadline) -> IO[bytes]:
    spooled = tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024)  # noqa: SIM115 - closed by the caller
    try:
        total = 0
        while True:
            deadline()
            chunk = stream.read(READ_CHUNK)
            if not chunk:
                break
            total += len(chunk)
            if total > cap:
                raise FileTooLarge
            spooled.write(chunk)
        spooled.seek(0)
    except BaseException:
        spooled.close()
        raise
    return spooled


def _codes_value(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    return None  # other types never match a code


def profile_parquet(
    stream: BinaryIO,
    *,
    path: str,
    plan: FilePlan,
    max_rows: int,
    max_bytes: int,
    deadline: Deadline,
    max_spool_bytes: int = DEFAULT_MAX_SPOOL_BYTES,
) -> FileStats:
    """`stream` should be seekable (see `open_parquet_range`). A non-seekable stream is spooled to a
    temporary file capped at `max_spool_bytes` (FileTooLarge when exceeded), always closed afterwards."""
    import pyarrow.parquet as pq

    spool: IO[bytes] | None = None
    try:
        source: Any = stream
        if not stream.seekable():
            spool = source = _spool(stream, max_spool_bytes, deadline)
        guard = _Guard(source)
        return _profile_parquet(pq, guard, path, plan, max_rows, max_bytes, deadline)
    finally:
        if spool is not None:
            spool.close()


def _profile_parquet(
    pq: Any, source: Any, path: str, plan: FilePlan, max_rows: int, max_bytes: int, deadline: Deadline
) -> FileStats:
    stats = FileStats(path=path)
    try:
        parquet = pq.ParquetFile(source)
    except Exception as exc:
        if source.failure is not None:
            raise source.failure from None
        if not _is_corrupt(exc):
            raise
        stats.encoding_error = True
        return stats
    schema = parquet.schema_arrow
    stats.header = tuple(schema.names)
    stats.parquet_types = {f.name: str(f.type) for f in schema}
    stats.parquet_numeric = tuple(sorted(f.name for f in schema if is_numeric_arrow_type(f.type)))
    first_index: dict[str, int] = {}
    for i, name in enumerate(schema.names):
        first_index.setdefault(name, i)  # duplicates are reported via duplicate_columns
    stats.columns = {name: ColumnStats() for name in first_index}
    compatible = {
        name: _arrow_compatible(plan.columns[name].declared_type or "string", schema.field(i).type)
        for name, i in first_index.items()
        if name in plan.columns
    }
    if max_rows <= 0:
        stats.truncated = parquet.metadata.num_rows > 0
        return stats
    consumed = 0
    try:
        for batch in parquet.iter_batches(batch_size=PARQUET_BATCH_ROWS):
            deadline()
            if stats.rows_read >= max_rows or consumed >= max_bytes:
                stats.truncated = True
                break
            take = min(batch.num_rows, max_rows - stats.rows_read)
            if take < batch.num_rows:
                stats.truncated = True
                batch = batch.slice(0, take)
            first_row = stats.rows_read + 1
            stats.rows_read += take
            stats.sampled_rows += take
            consumed += batch.nbytes
            for name, i in first_index.items():
                col_stats = stats.columns[name]
                column = batch.column(i)
                col_stats.missing += column.null_count
                col_plan = plan.columns.get(name)
                if col_plan is None:
                    continue
                non_null = len(column) - column.null_count
                if col_plan.declared_type is not None:
                    col_stats.checked += non_null
                    if not compatible[name]:
                        col_stats.invalid += non_null
                        if len(col_stats.first_invalid_rows) < FIRST_ROWS_LIMIT:
                            for offset, valid in enumerate(column.is_valid().to_pylist()):
                                if valid:
                                    col_stats.first_invalid_rows.append(first_row + offset)
                                    if len(col_stats.first_invalid_rows) >= FIRST_ROWS_LIMIT:
                                        break
                if col_plan.codes is not None:
                    for value in column.to_pylist():
                        if value is not None and _codes_value(value) not in col_plan.codes:
                            col_stats.undefined_codes += 1
    except Exception as exc:
        if source.failure is not None:
            raise source.failure from None
        if not _is_corrupt(exc):
            raise
        stats.encoding_error = True  # corrupt row group: keep the partial stats gathered so far
        return stats
    if not stats.truncated and parquet.metadata.num_rows > stats.rows_read:
        stats.truncated = True
    return stats
