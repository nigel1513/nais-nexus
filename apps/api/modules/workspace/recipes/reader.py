"""Read a pinned input version's table through the catalog's public CatalogReadPort (service credentials; the
workspace has already decided the caller may use the input).

Primary file: the first VERIFIED `.csv` / `.parquet` file of the version by path (the catalog lists files path
ascending). A version without one is not usable in a recipe (INPUT_NOT_TABULAR).

CSV: UTF-8 (BOM allowed), comma-delimited, header row required, quoted newlines allowed. Every column is read as
text, then typed over the rows read: integer, else float, else boolean (true/false), else text. Only canonical
spellings count: "007", "+1" and integers beyond int64 stay text. Missing
tokens: "", NA, N/A, null, NULL, NaN (same as readiness). Columns with no values stay text. Date/time columns stay
text until a cast_type step. Parquet: the file's own types; dictionary columns are decoded.

Bounded: rows are read in batches up to `max_rows` (truncate for previews, InputTooLarge for runs), every storage
read is capped and checks the caller's deadline, a file over `max_bytes` is refused before reading.
Errors never quote file content (pyarrow's messages do, so they are replaced).
"""

import csv
import io
import sys
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, BinaryIO

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.csv as pacsv
import pyarrow.parquet as pq

from api.modules.catalog.public import CatalogReadPort, FileRef, VersionView
from api.platform.bounded_io import BoundedLines, CappedRaw, Deadline, open_parquet_range

MISSING_TOKENS = ["", "NA", "N/A", "null", "NULL", "NaN"]
HEADER_BYTES = 1 << 20
BLOCK_BYTES = 1 << 20
PARQUET_BATCH_ROWS = 65_536
SCHEMA_SAMPLE_ROWS = 10_000  # recipe validation types columns over the same rows a preview reads
_KINDS = {".csv": "csv", ".parquet": "parquet"}


class InputTooLarge(Exception):  # noqa: N818
    """More rows than allowed, or a file larger than allowed (message names the limit, never data)."""


class InputUnreadable(Exception):  # noqa: N818
    """Not a well-formed CSV/Parquet table (message never quotes file content)."""


class ReadTimeout(Exception):  # noqa: N818
    """The caller's deadline passed while reading."""


def deadline_after(seconds: float) -> Deadline:
    end = time.monotonic() + seconds

    def check() -> None:
        if time.monotonic() > end:
            raise ReadTimeout()

    return check


def _no_deadline() -> None:
    return None


def file_kind(path: str) -> str | None:
    lower = path.lower()
    return next((kind for ext, kind in _KINDS.items() if lower.endswith(ext)), None)


def primary_file(version: VersionView) -> FileRef | None:
    return next((f for f in version.files if f.status == "VERIFIED" and file_kind(f.path)), None)


@dataclass(frozen=True)
class ReadResult:
    table: pa.Table
    truncated: bool  # more rows exist than were read


def read_table(
    port: CatalogReadPort,
    file: FileRef,
    *,
    max_rows: int,
    truncate: bool,
    max_bytes: int | None = None,
    deadline: Deadline = _no_deadline,
) -> ReadResult:
    kind = file_kind(file.path)
    if kind is None:
        raise InputUnreadable("The input file is neither CSV nor Parquet.")
    if max_bytes is not None and file.size_bytes > max_bytes:
        raise InputTooLarge(f"The input file is larger than the limit of {max_bytes:,} bytes.")
    if kind == "csv":
        result = _read_csv(port, file, max_rows, truncate, deadline)
    else:
        result = _read_parquet(port, file, max_rows, truncate, deadline)
    names = result.table.column_names
    if len(set(names)) != len(names):
        raise InputUnreadable("The input has duplicate column names.")
    return result


# ---------------------------------------------------------------- batches -> bounded table


def _collect(
    batches: Callable[[], Any], schema: pa.Schema, max_rows: int, truncate: bool, deadline: Deadline
) -> ReadResult:
    kept: list[pa.RecordBatch] = []
    rows = 0
    truncated = False
    for batch in batches():
        deadline()
        if rows + batch.num_rows > max_rows:
            if not truncate:
                raise InputTooLarge(f"The input has more than {max_rows:,} rows.")
            kept.append(batch.slice(0, max_rows - rows))
            truncated = True
            break
        kept.append(batch)
        rows += batch.num_rows
    return ReadResult(pa.Table.from_batches(kept, schema=schema), truncated)


# ---------------------------------------------------------------- CSV


def _header(port: CatalogReadPort, file: FileRef, deadline: Deadline) -> list[str]:
    if file.size_bytes == 0:
        raise InputUnreadable("The CSV file is empty.")
    raw = port.open_stream(file, (0, min(file.size_bytes, HEADER_BYTES) - 1))
    capped = CappedRaw(raw, deadline)
    try:
        text = io.TextIOWrapper(io.BufferedReader(capped), encoding="utf-8-sig", newline="")
        lines = BoundedLines(text, HEADER_BYTES)
        row = next(csv.reader(lines), None)
    except UnicodeDecodeError as exc:
        raise InputUnreadable("The CSV header is not valid UTF-8.") from exc
    except csv.Error as exc:
        raise InputUnreadable("The CSV header cannot be parsed.") from exc
    except Exception:
        if capped.failure is not None:
            raise capped.failure from None
        raise
    finally:
        raw.close()
    if capped.failure is not None:
        raise capped.failure
    if lines.overflow or (lines.bytes >= HEADER_BYTES and file.size_bytes > HEADER_BYTES):
        raise InputUnreadable("The CSV header is longer than 1 MiB.")
    if not row or row == [""]:
        raise InputUnreadable("The CSV file has no header row.")
    return row


def _read_csv(
    port: CatalogReadPort, file: FileRef, max_rows: int, truncate: bool, deadline: Deadline
) -> ReadResult:
    names = _header(port, file, deadline)
    if len(set(names)) != len(names):
        raise InputUnreadable("The input has duplicate column names.")
    raw = port.open_stream(file)
    capped = CappedRaw(raw, deadline)
    try:
        reader = pacsv.open_csv(
            io.BufferedReader(capped, buffer_size=BLOCK_BYTES),
            read_options=pacsv.ReadOptions(
                column_names=names, skip_rows=1, block_size=BLOCK_BYTES, use_threads=False
            ),
            parse_options=pacsv.ParseOptions(newlines_in_values=True),
            convert_options=pacsv.ConvertOptions(
                column_types={n: pa.string() for n in names},
                null_values=MISSING_TOKENS,
                strings_can_be_null=True,
            ),
        )
        result = _collect(lambda: reader, reader.schema, max_rows, truncate, deadline)
    except (pa.ArrowInvalid, pa.ArrowNotImplementedError, OSError) as exc:
        if capped.failure is not None:
            raise capped.failure from None
        raise InputUnreadable(_csv_problem(exc)) from None
    finally:
        raw.close()
    return ReadResult(_typed(result.table), result.truncated)


def _csv_problem(exc: BaseException) -> str:
    text = str(exc)
    if "UTF8" in text or "UTF-8" in text:
        return "The CSV file is not valid UTF-8."
    if "Expected" in text and "columns" in text:
        return "A CSV row has a different number of fields than the header."
    return "The CSV file cannot be parsed."


# Canonical number spellings only: no "+", no leading zeros (but "0" and "0.5"), so "007" / "+1" / zip codes and
# other identifiers stay text. A column typed float must also be exact: every value's float64 is the same number as
# its text (see _floats_exact); otherwise the column stays text.
_INTEGER = r"^(0|-?[1-9][0-9]*)$"
_DECIMAL = r"^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$|^-?\.[0-9]+$"
_BOOLEAN = r"^(?i:true|false)$"
SAFE_SIGNIFICANT_DIGITS = (
    15  # a normal-range decimal with at most 15 significant digits survives float64 exactly
)
SMALLEST_NORMAL = sys.float_info.min  # below it float64 underflows (subnormal or 0.0) and loses digits


def _all_match(values: pa.ChunkedArray, pattern: str) -> bool:
    return bool(pc.all(pc.match_substring_regex(values, pattern)).as_py())


def _floats_exact(values: pa.ChunkedArray) -> bool:
    """Every value converts to a finite float64 that is the same number as its text, and integer-looking values fit
    int64. Normal-range values with at most 15 significant digits are exact by construction; the longer ones and every
    value below the normal range (underflow to 0.0 / subnormals, e.g. "1e-400") are checked one by one
    (Decimal(text) == Decimal(repr(float)))."""
    integers = values.filter(pc.match_substring_regex(values, _INTEGER))
    if len(integers):
        try:
            pc.cast(integers, pa.int64())
        except pa.ArrowInvalid:
            return False
    floats = pc.cast(values, pa.float64())
    if not bool(pc.all(pc.is_finite(floats)).as_py()):
        return False
    mantissa = pc.replace_substring_regex(values, r"[eE].*$", "")
    digits = pc.replace_substring_regex(pc.replace_substring_regex(mantissa, r"[^0-9]", ""), r"^0+|0+$", "")
    long = pc.greater(pc.utf8_length(digits), SAFE_SIGNIFICANT_DIGITS)
    tiny = pc.less(pc.abs(floats), SMALLEST_NORMAL)  # 0.0 included: "0.0" passes, "1e-400" does not
    checked = values.filter(pc.or_(long, tiny))
    return all(Decimal(text) == Decimal(repr(float(text))) for text in pc.unique(checked).to_pylist())


def _typed(table: pa.Table) -> pa.Table:
    """Text columns -> integer / float / boolean when every value read is a canonical spelling of one;
    otherwise text. Integer columns must fit int64 and float columns must be exact (_floats_exact); anything else
    stays text, so identifiers and long numbers never lose digits."""
    for i, name in enumerate(table.column_names):
        col = table.column(i)
        if col.null_count == len(col):
            continue
        trimmed = pc.utf8_trim_whitespace(col)
        typed: pa.ChunkedArray | None = None
        try:
            if _all_match(trimmed, _INTEGER):
                typed = pc.cast(trimmed, pa.int64())
            elif _all_match(trimmed, _DECIMAL) and _floats_exact(trimmed):
                typed = pc.cast(trimmed, pa.float64())
            elif _all_match(trimmed, _BOOLEAN):
                typed = pc.cast(pc.utf8_lower(trimmed), pa.bool_())
        except (pa.ArrowInvalid, pa.ArrowNotImplementedError):
            typed = None  # e.g. integer overflow: keep the text
        if typed is not None:
            table = table.set_column(i, name, typed)
    return table


# ---------------------------------------------------------------- Parquet


def _read_parquet(
    port: CatalogReadPort, file: FileRef, max_rows: int, truncate: bool, deadline: Deadline
) -> ReadResult:
    def open_range(start: int, end: int) -> BinaryIO:
        return port.open_stream(file, (start, end))

    source = open_parquet_range(open_range, file.size_bytes, deadline=deadline)
    raw = source.raw  # type: ignore[attr-defined]
    try:
        parquet = pq.ParquetFile(source)
        schema = parquet.schema_arrow
        decoded = pa.schema(
            [
                pa.field(f.name, f.type.value_type if pa.types.is_dictionary(f.type) else f.type)
                for f in schema
            ]
        )

        def batches() -> Any:
            for batch in parquet.iter_batches(batch_size=PARQUET_BATCH_ROWS, use_threads=False):
                yield _decode(batch, decoded)

        return _collect(batches, decoded, max_rows, truncate, deadline)
    except (pa.ArrowInvalid, pa.ArrowNotImplementedError, OSError) as exc:
        if raw.failure is not None:
            raise raw.failure from None
        raise InputUnreadable("The Parquet file cannot be read.") from exc
    except Exception:
        if raw.failure is not None:
            raise raw.failure from None
        raise
    finally:
        source.close()


def _decode(batch: pa.RecordBatch, schema: pa.Schema) -> pa.RecordBatch:
    if batch.schema.equals(schema):
        return batch
    columns = [
        pc.cast(col, schema.field(i).type) if pa.types.is_dictionary(col.type) else col
        for i, col in enumerate(batch.columns)
    ]
    return pa.RecordBatch.from_arrays(columns, schema=schema)


# ---------------------------------------------------------------- schema cache


class SchemaCache:
    """file_id -> schema of the first SCHEMA_SAMPLE_ROWS rows. Files of PUBLISHED versions never change (sha256
    is part of the key anyway), so entries never go stale; bounded LRU."""

    def __init__(self, size: int = 256) -> None:
        self._size = size
        self._entries: OrderedDict[tuple[Any, str], pa.Schema] = OrderedDict()
        self._lock = threading.Lock()

    def schema(self, port: CatalogReadPort, file: FileRef, deadline: Deadline = _no_deadline) -> pa.Schema:
        key = (file.file_id, file.sha256)
        with self._lock:
            if key in self._entries:
                self._entries.move_to_end(key)
                return self._entries[key]
        schema = read_table(
            port, file, max_rows=SCHEMA_SAMPLE_ROWS, truncate=True, deadline=deadline
        ).table.schema
        with self._lock:
            self._entries[key] = schema
            while len(self._entries) > self._size:
                self._entries.popitem(last=False)
        return schema


SCHEMAS = SchemaCache()
