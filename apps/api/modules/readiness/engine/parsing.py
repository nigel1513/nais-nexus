"""One streaming pass per tabular file -> per-column statistics (09 §1.4). Never keeps cell values.

CSV: stdlib csv, every value a str, fixed delimiter by extension, UTF-8 (BOM allowed). Parquet: pyarrow
iter_batches in row-group order. Sample = first `sample_max_rows` data rows within `sample_max_bytes`.
"""

import csv
import io
import re
import shutil
import tempfile
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date
from typing import IO, Any, BinaryIO

DEFAULT_MISSING = frozenset({"", "NA", "N/A", "null", "NULL", "NaN"})
FIRST_ROWS_LIMIT = 10

_INTEGER = re.compile(r"[+-]?[0-9]+")
_NUMBER = re.compile(r"[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?")
_BOOLEAN = frozenset({"true", "false", "True", "False", "TRUE", "FALSE", "1", "0"})
_DATE = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})")
_DATETIME = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?"
    r"([Zz]|[+-]([0-9]{2}):([0-9]{2}))"
)


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
    stats = FileStats(path=path)
    text = io.TextIOWrapper(stream, encoding="utf-8-sig", newline="")
    reader = csv.reader(text, delimiter=delimiter, quotechar='"')
    consumed = 0
    try:
        try:
            header = next(reader)
        except StopIteration:
            return stats
        stats.header = tuple(header)
        index: dict[str, int] = {}
        for i, name in enumerate(header):
            index.setdefault(name, i)
        stats.columns = {name: ColumnStats() for name in index}
        slots = [(name, i, plan.columns.get(name)) for name, i in index.items()]
        width = len(header)
        while True:
            try:
                row = next(reader)
            except StopIteration:
                break
            except csv.Error:
                stats.rows_read += 1
                stats.malformed_rows += 1
                continue
            if not row:
                continue  # blank line: not a data row
            if stats.rows_read >= max_rows or consumed >= max_bytes:
                stats.truncated = True
                break
            stats.rows_read += 1
            consumed += sum(len(v.encode("utf-8")) for v in row) + len(row)
            if stats.rows_read % 1000 == 0:
                deadline()
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


def _seekable(stream: BinaryIO) -> IO[bytes]:
    if stream.seekable():
        return stream
    spooled = tempfile.SpooledTemporaryFile(max_size=64 * 1024 * 1024)  # noqa: SIM115 - returned to caller
    shutil.copyfileobj(stream, spooled)
    spooled.seek(0)
    return spooled


def profile_parquet(
    stream: BinaryIO, *, path: str, plan: FilePlan, max_rows: int, max_bytes: int, deadline: Deadline
) -> FileStats:
    import pyarrow.parquet as pq

    stats = FileStats(path=path)
    try:
        parquet = pq.ParquetFile(_seekable(stream))
    except Exception:  # not a parquet file: same verdict as an undecodable CSV
        stats.encoding_error = True
        return stats
    schema = parquet.schema_arrow
    stats.header = tuple(schema.names)
    stats.parquet_types = {f.name: str(f.type) for f in schema}
    stats.parquet_numeric = tuple(sorted(f.name for f in schema if is_numeric_arrow_type(f.type)))
    stats.columns = {name: ColumnStats() for name in dict.fromkeys(schema.names)}
    compatible = {
        f.name: _arrow_compatible(plan.columns[f.name].declared_type or "string", f.type)
        for f in schema
        if f.name in plan.columns
    }
    consumed = 0
    for batch in parquet.iter_batches(batch_size=min(max_rows, 65536)):
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
        for name, col_stats in stats.columns.items():
            column = batch.column(schema.get_field_index(name))
            col_stats.missing += column.null_count
            col_plan = plan.columns.get(name)
            if col_plan is None:
                continue
            for offset, value in enumerate(column.to_pylist()):
                if value is None:
                    continue
                if col_plan.declared_type is not None:
                    col_stats.checked += 1
                    if not compatible[name]:
                        col_stats.invalid += 1
                        if len(col_stats.first_invalid_rows) < FIRST_ROWS_LIMIT:
                            col_stats.first_invalid_rows.append(first_row + offset)
                if col_plan.codes is not None and str(value) not in col_plan.codes:
                    col_stats.undefined_codes += 1
    if not stats.truncated and parquet.metadata.num_rows > stats.rows_read:
        stats.truncated = True
    return stats
