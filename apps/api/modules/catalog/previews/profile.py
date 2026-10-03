"""Bounded column profiling for the Data Explorer (Wave 1.5 spec §7). Hostile-file rules follow 09 §1.4:
every read is capped and checks the deadline, physical lines are capped, sample rows/bytes are capped.

column_profile = metadata-visible (no raw values). preview = raw-value-bearing (download permission only).
Histograms are computed from a deterministic reservoir sample (≤ 2,000 values per column); min/max/mean are exact
over the sample rows. The preview JSON never exceeds `preview_bytes`: rows are dropped from the end first
(`rows_truncated`), then the distributions (`columns: []`, ruling P17), then over-long header names are shortened.
column_profile is bounded too: names/units/descriptions are cut to `cell_chars`, and a profile over `profile_bytes`
degrades (descriptions, then units/IRIs dropped, then names cut to 64) before it is Unparseable. Non-finite floats: NaN is missing (like the CSV token "NaN"); ±inf is a present
value that is excluded from min/max/mean/histogram and from top values. Parquet nested and binary columns are never
decoded: they are profiled as kind "other" with no values.

Parquet dictionary pages are sized from the page header at the offset the decoder starts the chunk at (never from
footer sizes). The whole PageHeader is parsed strictly (no long-form or repeated top-level fields, bounded nesting,
only the peeked bytes); a column whose footer and page headers disagree, whose first page is an INDEX_PAGE or of an
unknown type, or whose header does not parse is profiled as "other" (never decoded). Decompression bombs in
PLAIN data pages (a small compressed page declaring a huge uncompressed size) are not header-checked here: they are
bounded by the child-process RLIMIT_AS planned in Task 11 (controller ruling P24)."""

import csv
import io
import json
import math
import random
import re
import time
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, BinaryIO

from api.platform.bounded_io import BoundedLines, CappedRaw, Deadline, open_parquet_range

MISSING = frozenset({"", "NA", "N/A", "null", "NULL", "NaN"})
LINE_CAP = 1 << 20  # one physical line
RECORD_CAP = 4 << 20  # one CSV record (header or row; quoted fields may span lines)
MAX_IRI_CHARS = 512
RESERVOIR = 2_000
CATEGORICAL_MAX_DISTINCT = 50
MAX_TOP_VALUES = 10  # hard caps (ruling P2) whatever PreviewLimits asks for
MAX_HISTOGRAM_BINS = 20
PARQUET_BATCH_ROWS = 1024
PARQUET_STREAM_BUFFER = 1 << 20  # stream column chunks page by page instead of fetching them whole
# the first batch fetches about one page (plus a dictionary page) per decoded column: estimated per column as
# min(chunk size, 2 × stream buffer); the decoded columns are limited so these estimates fit max_bytes, and the
# bytes actually fetched for data pages are capped at PARQUET_FETCH_FACTOR × max_bytes
PARQUET_FIRST_BATCH_COST = 2 * PARQUET_STREAM_BUFFER
PARQUET_FETCH_FACTOR = 2
TYPE_ORDER = ("integer", "number", "boolean", "date", "datetime")
_PATTERNS = {
    "integer": re.compile(r"[+-]?[0-9]+"),
    "number": re.compile(r"[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?"),
    "date": re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}"),
    "datetime": re.compile(
        r"[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:?[0-9]{2})?"
    ),
}
_BOOLEAN = frozenset({"true", "false", "True", "False", "TRUE", "FALSE"})
MAX_TYPED_LEN = 64  # longer values are never numbers/dates: skip the regex (ReDoS-safe, like 09 §1.4)


class PreviewTimeout(Exception):
    """Profiling one file exceeded its time budget."""


class Unparseable(Exception):
    """The file cannot be read as the table its extension claims (preview FAILED / UNPARSEABLE)."""


class _FetchBudgetSpent(Exception):
    """More than max_bytes were fetched from storage for one parquet file: stop reading (truncate)."""


@dataclass(frozen=True)
class PreviewLimits:
    max_rows: int = 10_000
    max_bytes: int = 64 << 20
    max_columns: int = 200
    preview_rows: int = 100
    cell_chars: int = 200
    preview_bytes: int = 256 << 10
    distinct_cap: int = 1_000
    histogram_bins: int = 10
    profile_bytes: int = 256 << 10
    top_values: int = 10


@dataclass(frozen=True)
class FieldHint:
    type: str | None = None
    unit: str | None = None
    description: str | None = None
    concept_iri: str | None = None


MAX_TOTAL_ROWS = 2**53 - 1  # exact in a JSON number / JS double


@dataclass
class ProfileResult:
    format: str
    rows_sampled: int
    truncated: bool
    columns_truncated: bool
    column_profile: list[dict[str, Any]]
    preview: dict[str, Any]
    # Exact row count when known (contract FileProfile.total_rows). CSV/TSV: the well-formed data records a read to
    # EOF counted, i.e. rows_sampled of an untruncated sample (blank and malformed records are skipped everywhere,
    # as in rows_sampled); None when the sample stopped early. Parquet: parquet_total_rows (footer, bounded).
    total_rows: int | None = None


@dataclass
class _Column:
    name: str
    hint: FieldHint
    seen: int = 0
    missing: int = 0
    distinct: set[int] = field(default_factory=set)
    distinct_capped: bool = False
    type_hits: Counter[str] = field(default_factory=Counter)
    numbers: list[float] = field(default_factory=list)
    n_numeric: int = 0
    total: float = 0.0
    low: float = math.inf
    high: float = -math.inf
    counts: Counter[str] = field(default_factory=Counter)
    decoded: bool = True  # False: a parquet nested/binary column that is never read (kind "other")


def table_format(path: str) -> str | None:
    name = path.rsplit("/", 1)[-1]
    if name.startswith("_"):
        return None
    lower = name.lower()
    for ext, fmt in ((".csv", "csv"), (".tsv", "tsv"), (".parquet", "parquet")):
        if lower.endswith(ext):
            return fmt
    return None


def make_deadline(seconds: float, clock: Callable[[], float] = time.monotonic) -> Deadline:
    end = clock() + seconds

    def check() -> None:
        if clock() > end:
            raise PreviewTimeout

    return check


def _types_of(value: str) -> list[str]:
    if value in _BOOLEAN:
        return ["boolean"]
    if len(value) > MAX_TYPED_LEN:
        return []
    return [t for t in ("integer", "number", "date", "datetime") if _PATTERNS[t].fullmatch(value)]


def _make_column(name: str, hint: FieldHint, limits: PreviewLimits) -> _Column:
    """`hint` was looked up by the full name; everything kept in the profile is cut to `cell_chars`."""
    cut = limits.cell_chars
    iri = hint.concept_iri if hint.concept_iri and len(hint.concept_iri) <= MAX_IRI_CHARS else None
    return _Column(
        name[:cut],
        FieldHint(
            hint.type,
            hint.unit[:cut] if hint.unit else hint.unit,
            hint.description[:cut] if hint.description else hint.description,
            iri,
        ),
    )


def _observe(
    col: _Column, value: str | None, limits: PreviewLimits, rng: random.Random, nonfinite: bool = False
) -> None:
    col.seen += 1
    if value is None or value in MISSING:
        col.missing += 1
        return
    if not col.distinct_capped:
        col.distinct.add(hash(value))
        if len(col.distinct) > limits.distinct_cap:
            col.distinct_capped = True
            col.distinct.clear()  # the count is reported as the cap from here on
    if nonfinite:
        return  # ±inf: present, but neither a top value nor part of the numeric statistics
    key = value[: limits.cell_chars]
    # top values only matter for categorical columns (≤ CATEGORICAL_MAX_DISTINCT distinct): bound the counter
    if key in col.counts or len(col.counts) <= CATEGORICAL_MAX_DISTINCT:
        col.counts[key] += 1
    types = _types_of(value)
    for t in types:
        col.type_hits[t] += 1
    if "number" in types:
        x = float(value)
        if math.isfinite(x):
            col.n_numeric += 1
            col.total += x
            col.low, col.high = min(col.low, x), max(col.high, x)
            if len(col.numbers) < RESERVOIR:
                col.numbers.append(x)
            else:
                j = rng.randrange(col.n_numeric)
                if j < RESERVOIR:
                    col.numbers[j] = x


def _column_type(col: _Column) -> str:
    if col.hint.type:
        return col.hint.type
    present = col.seen - col.missing
    if present == 0:
        return "string"
    for t in TYPE_ORDER:
        if col.type_hits[t] == present:
            return t
    return "string"


def _sig(x: float) -> float:
    """Round to 12 significant digits: readable edges without collapsing very narrow spans."""
    return float(f"{x:.12g}")


def _histogram(col: _Column, bins: int) -> list[dict[str, Any]]:
    if not col.numbers:
        return []
    # work on halves so that high - low can never overflow to inf for values near ±1.8e308
    lo_half = col.low / 2
    step_half = (col.high / 2 - lo_half) / bins
    if col.low == col.high or not step_half > 0:  # one value (or a span too small to split)
        return [{"lower": col.low, "upper": col.high, "count": col.n_numeric}]
    counts = [0] * bins
    for x in col.numbers:
        counts[min(max(int((x / 2 - lo_half) / step_half), 0), bins - 1)] += 1
    scale = col.n_numeric / len(col.numbers)
    out = [
        {
            "lower": col.low if i == 0 else _sig((lo_half + i * step_half) * 2),
            "upper": _sig((lo_half + (i + 1) * step_half) * 2) if i < bins - 1 else col.high,
            "count": round(c * scale),
        }
        for i, c in enumerate(counts)
    ]
    out[-1]["count"] += col.n_numeric - sum(b["count"] for b in out)  # keep the total exact after scaling
    return out


def _distribution(col: _Column, ctype: str, limits: PreviewLimits) -> dict[str, Any]:
    if not col.decoded:
        return {"name": col.name[: limits.cell_chars], "kind": "other"}
    if ctype in ("integer", "number") and col.n_numeric:
        mean = col.total / col.n_numeric
        return {
            "name": col.name[: limits.cell_chars],
            "kind": "numeric",
            "min": col.low,
            "max": col.high,
            "mean": _sig(mean) if math.isfinite(mean) else None,
            "histogram": _histogram(col, max(1, min(limits.histogram_bins, MAX_HISTOGRAM_BINS))),
        }
    if ctype == "boolean" or (not col.distinct_capped and len(col.distinct) <= CATEGORICAL_MAX_DISTINCT):
        top = max(0, min(limits.top_values, MAX_TOP_VALUES))
        return {
            "name": col.name[: limits.cell_chars],
            "kind": "categorical",
            "top_values": [{"value": v, "count": n} for v, n in col.counts.most_common(top)],
        }
    return {"name": col.name[: limits.cell_chars], "kind": "other"}


def _cell(value: Any, limits: PreviewLimits) -> str | None:
    if value is None:
        return None
    text = value if isinstance(value, str) else str(value)
    return None if text in MISSING else text[: limits.cell_chars]


def _size(value: Any) -> int:
    """Encoded size, measured as ASCII-escaped JSON: an upper bound for any compact/UTF-8 serialisation."""
    return len(json.dumps(value))


def _fit_preview(preview: dict[str, Any], budget: int) -> dict[str, Any]:
    rows: list[list[str | None]] = preview["rows"]
    preview["rows"] = []
    base = _size(preview)
    kept, used = 0, base
    for row in rows:
        extra = _size(row) + (2 if kept else 0)  # ", " separator between rows
        if used + extra > budget:
            break
        used += extra
        kept += 1
    preview["rows"] = rows[:kept]
    preview["rows_truncated"] = kept < len(rows)
    if base > budget:  # even without rows: drop the distributions (rulings P2, P17)
        preview["columns"] = []
        cap = max((len(h) for h in preview["header"]), default=0)
        while _size(preview) > budget and cap > 1:  # pathological header names
            cap //= 2
            preview["header"] = [h[:cap] for h in preview["header"]]
    return preview


PROFILE_NAME_FALLBACK = 64


def _profile_size(profile: list[dict[str, Any]]) -> int:
    return len(json.dumps(profile, ensure_ascii=False).encode("utf-8", "surrogatepass"))


def _fit_profile(profile: list[dict[str, Any]], budget: int) -> None:
    """Degrade, never silently overflow: drop descriptions, then units and concept IRIs, then shorten names to 64
    chars; only if it still does not fit is the file Unparseable. No flag is added: FileProfile in contract 1.3.0
    declares none (same reasoning as ruling P17), and the dropped fields are nullable."""
    steps: list[Callable[[dict[str, Any]], None]] = [
        lambda c: c.update(description=None),
        lambda c: c.update(unit=None, concept_iri=None),
        lambda c: c.update(name=c["name"][:PROFILE_NAME_FALLBACK]),
    ]
    for step in [None, *steps]:
        if step is not None:
            for column in profile:
                step(column)
        if _profile_size(profile) <= budget:
            return
    raise Unparseable("column profile exceeds its size ceiling")


def _finish(
    fmt: str,
    cols: list[_Column],
    rows: list[list[str | None]],
    sampled: int,
    truncated: bool,
    columns_truncated: bool,
    limits: PreviewLimits,
    total_rows: int | None,
) -> ProfileResult:
    profile, dists = [], []
    for col in cols:
        ctype = _column_type(col)
        profile.append(
            {
                "name": col.name,
                "type": ctype,
                "unit": col.hint.unit,
                "description": col.hint.description,
                "concept_iri": col.hint.concept_iri,
                "missing_ratio": round(col.missing / col.seen, 6) if col.seen else 0.0,
                "distinct_count": limits.distinct_cap if col.distinct_capped else len(col.distinct),
                "distinct_capped": col.distinct_capped,
            }
        )
        dists.append(_distribution(col, ctype, limits))
    _fit_profile(profile, limits.profile_bytes)
    preview: dict[str, Any] = {
        "header": [c.name[: limits.cell_chars] for c in cols],
        "rows": rows,
        "rows_truncated": False,
        "columns": dists,
    }
    return ProfileResult(
        fmt,
        sampled,
        truncated,
        columns_truncated,
        profile,
        _fit_preview(preview, limits.preview_bytes),
        total_rows,
    )


class _RecordCap:
    """Counts the characters of the physical lines the csv reader pulls for one record; past `cap` it ends the
    iterator and flags `overflow`, so one record (quoted fields may span lines) never grows unbounded."""

    def __init__(self, lines: BoundedLines, cap: int) -> None:
        self._lines = lines
        self._cap = cap
        self.used = 0
        self.overflow = False

    def __iter__(self) -> "_RecordCap":
        return self

    def __next__(self) -> str:
        if self.overflow:
            raise StopIteration
        line = next(self._lines)
        self.used += len(line)
        if self.used > self._cap:
            self.overflow = True
            raise StopIteration
        return line


def _profile_delimited(
    stream: BinaryIO, fmt: str, hints: dict[str, FieldHint], limits: PreviewLimits, deadline: Deadline
) -> ProfileResult:
    text = io.TextIOWrapper(io.BufferedReader(CappedRaw(stream, deadline)), encoding="utf-8-sig", newline="")
    lines = BoundedLines(text, max(1, min(limits.max_bytes, LINE_CAP)))
    record = _RecordCap(lines, max(1, min(limits.max_bytes, RECORD_CAP)))
    reader = csv.reader(record, delimiter="\t" if fmt == "tsv" else ",")
    rng = random.Random(0)
    # blank / malformed records are skipped but still bounded: at most max_rows of them, plus the byte budget
    max_skipped = max(1, limits.max_rows)
    try:
        deadline()
        try:
            header = next(reader)
        except (StopIteration, csv.Error) as exc:
            raise Unparseable from exc
        # the header counts toward the byte budget (no reset of lines.bytes)
        if lines.overflow or record.overflow or not header or lines.bytes > limits.max_bytes:
            raise Unparseable
        columns_truncated = len(header) > limits.max_columns
        cols = [_make_column(n, hints.get(n, FieldHint()), limits) for n in header[: limits.max_columns]]
        width = len(header)
        del header  # only the first max_columns names are kept (cut) in `cols`
        rows: list[list[str | None]] = []
        sampled, skipped, truncated = 0, 0, False
        while True:
            deadline()
            record.used = 0
            row: list[str] | None
            try:
                row = next(reader)
            except StopIteration:
                break
            except csv.Error:
                row = None  # e.g. a field over the csv field limit: skipped like a malformed row
            if lines.overflow or record.overflow:
                raise Unparseable
            # limits first, on every record (blank and malformed included), like readiness parsing.py
            if lines.bytes > limits.max_bytes or skipped >= max_skipped:
                truncated = True
                break
            if not row or len(row) != width:
                skipped += 1  # blank or malformed: readiness reports it; the explorer skips it
                continue
            if sampled >= limits.max_rows:
                truncated = True
                break
            sampled += 1
            for col, value in zip(cols, row, strict=False):
                _observe(col, value, limits, rng)
            if len(rows) < limits.preview_rows:
                rows.append([_cell(v, limits) for v in row[: limits.max_columns]])
        if lines.overflow or record.overflow:  # ruling P1: never READY after an over-long line/record
            raise Unparseable
    except UnicodeDecodeError as exc:
        raise Unparseable from exc
    finally:
        text.detach()
    # A read to the end counts every well-formed record; a truncated sample does not know the total.
    return _finish(
        fmt, cols, rows, sampled, truncated, columns_truncated, limits, None if truncated else sampled
    )


_ARROW_TYPES = (
    ("is_boolean", "boolean"),
    ("is_integer", "integer"),
    ("is_floating", "number"),
    ("is_decimal", "number"),
    ("is_date", "date"),
    ("is_timestamp", "datetime"),
)


def _is_corrupt(exc: BaseException) -> bool:
    """Undecodable parquet content (as in readiness): storage/network/OS errors are NOT corruption."""
    import pyarrow as pa

    if isinstance(exc, pa.ArrowInvalid | pa.ArrowNotImplementedError):
        return True
    return type(exc) is OSError and exc.errno is None  # pyarrow's report about bytes read successfully


def _leaf_count(arrow_type: Any) -> int:
    """Parquet leaf (physical) columns behind one top-level Arrow field."""
    import pyarrow as pa

    t = pa.types
    if t.is_struct(arrow_type):
        return sum(_leaf_count(arrow_type.field(k).type) for k in range(arrow_type.num_fields))
    if t.is_map(arrow_type):
        return _leaf_count(arrow_type.key_type) + _leaf_count(arrow_type.item_type)
    if t.is_list(arrow_type) or t.is_large_list(arrow_type) or t.is_fixed_size_list(arrow_type):
        return _leaf_count(arrow_type.value_type)
    return 1


def _readable(arrow_type: Any) -> bool:
    """Flat scalar types whose cells are small once decoded. Nested and binary columns are never read."""
    import pyarrow as pa

    t = pa.types
    if t.is_dictionary(arrow_type):
        return _readable(arrow_type.value_type)
    return bool(
        t.is_boolean(arrow_type)
        or t.is_integer(arrow_type)
        or t.is_floating(arrow_type)
        or t.is_decimal(arrow_type)
        or t.is_date(arrow_type)
        or t.is_timestamp(arrow_type)
        or t.is_time(arrow_type)
        or t.is_duration(arrow_type)
        or t.is_string(arrow_type)
        or t.is_large_string(arrow_type)
    )


def _column_values(column: Any) -> list[Any]:
    """Python values of one batch column. Dictionary columns are expanded by reference: every row shares the
    dictionary's Python object, so a huge entry exists once (its str hash is cached too)."""
    import pyarrow as pa

    if pa.types.is_dictionary(column.type):
        dictionary = column.dictionary.to_pylist()
        return [None if i is None else dictionary[i] for i in column.indices.to_pylist()]
    return list(column.to_pylist())


def _parquet_value(value: Any) -> tuple[str | None, bool]:
    """(text, non-finite). NaN is missing; ±inf is present but non-finite."""
    if value is None:
        return None, False
    if isinstance(value, float) and not math.isfinite(value):
        return (None, False) if math.isnan(value) else (str(value), True)
    return str(value), False


_DATA_PAGE, _DICTIONARY_PAGE, _DATA_PAGE_V2 = (
    0,
    2,
    3,
)  # parquet PageType (1 = INDEX_PAGE, skipped by the decoder)
PAGE_HEADER_PEEK = 256  # a dictionary or numeric data page header fits; larger ones get one second peek
PAGE_HEADER_MAX = (
    64 << 10
)  # writers cap page statistics (parquet-cpp: 4 KiB per value); larger headers are "other"
_THRIFT_MAX_DEPTH = 8  # PageHeader nests at most 3 deep (PageHeader > DataPageHeader > Statistics)
_I32 = 5


class _ShortHeader(Exception):
    """The peeked bytes end before the PageHeader does."""


class _ThriftCompact:
    """A strict reader for one thrift-compact struct held entirely in `buf` (never reads past it)."""

    def __init__(self, buf: bytes) -> None:
        self.buf, self.pos = buf, 0

    def byte(self) -> int:
        if self.pos >= len(self.buf):
            raise _ShortHeader
        self.pos += 1
        return self.buf[self.pos - 1]

    def skip(self, n: int) -> None:
        if n < 0:
            raise ValueError("negative length")
        if self.pos + n > len(self.buf):
            raise _ShortHeader
        self.pos += n

    def varint(self) -> int:
        result = 0
        for shift in range(0, 70, 7):
            b = self.byte()
            result |= (b & 0x7F) << shift
            if not b & 0x80:
                return result
        raise ValueError("varint too long")

    def zigzag(self) -> int:
        raw = self.varint()
        return (raw >> 1) ^ -(raw & 1)

    def value(self, wire: int, depth: int) -> None:
        """Skip one value of compact wire type `wire` (in a struct field: bools carry no payload)."""
        if wire in (1, 2):
            return
        if wire == 3:
            self.skip(1)
        elif wire in (4, 5, 6):
            self.varint()
        elif wire == 7:
            self.skip(8)
        elif wire == 8:
            self.skip(self.varint())
        elif wire in (9, 10):
            self.nest(depth + 1)
            head = self.byte()
            count = head >> 4 if head >> 4 != 15 else self.varint()
            for _ in range(count):  # every element is at least one byte, so this is bounded by the buffer
                self.element(head & 0x0F, depth + 1)
        elif wire == 11:
            self.nest(depth + 1)
            count = self.varint()
            if count:
                kv = self.byte()
                for _ in range(count):
                    self.element(kv >> 4, depth + 1)
                    self.element(kv & 0x0F, depth + 1)
        elif wire == 12:
            self.struct(depth + 1)
        else:
            raise ValueError(f"unknown thrift wire type {wire}")

    def element(self, wire: int, depth: int) -> None:
        if wire in (1, 2):  # a bool inside a collection is one byte
            self.skip(1)
        else:
            self.value(wire, depth)

    @staticmethod
    def nest(depth: int) -> None:
        """Structs, lists, sets and maps all count toward the nesting bound."""
        if depth > _THRIFT_MAX_DEPTH:
            raise ValueError("thrift value nested too deep")

    def struct(self, depth: int) -> None:
        self.nest(depth)
        field_id = 0
        while True:
            head = self.byte()
            if head == 0:
                return
            if head >> 4:
                field_id += head >> 4
            else:
                field_id = self.zigzag()  # long form (legal in nested structs, which are only skipped)
            self.value(head & 0x0F, depth)

    def page_header(self) -> tuple[int, int]:
        """(type, max(uncompressed_page_size, compressed_page_size)) of a whole top-level PageHeader. Stricter than the thrift decoder:
        every long-form field header or repeated field id is rejected, because the decoder keeps the LAST value
        of a repeated field (a first-match parser could be shown a tiny size while pyarrow allocates a huge one)."""
        fields: dict[int, int] = {}
        field_id = 0
        while True:
            head = self.byte()
            if head == 0:
                break
            if not head >> 4:
                raise ValueError("long-form field header in PageHeader")
            field_id += head >> 4
            if field_id in fields:
                raise ValueError("repeated PageHeader field")
            wire = head & 0x0F
            if field_id in (1, 2, 3):
                if wire != _I32:
                    raise ValueError("PageHeader type/sizes must be i32")
                value = self.zigzag()
                if not -(1 << 31) <= value < 1 << 31:
                    raise ValueError("i32 out of range")
                fields[field_id] = value
            else:
                fields[field_id] = 0
                self.value(wire, 1)
        if not {1, 2, 3} <= fields.keys() or fields[2] < 0 or fields[3] < 0:
            raise ValueError("PageHeader without type and sizes")
        # for UNCOMPRESSED chunks the decoder reads compressed_page_size (field 3) bytes and ignores field 2;
        # otherwise it decompresses into uncompressed_page_size (field 2): the larger one bounds both
        return fields[1], max(fields[2], fields[3])


def page_header_sizes(buf: bytes) -> tuple[int, int] | None:
    """(page type, page size the decoder allocates: max of fields 2 and 3) of the thrift-compact PageHeader that `buf` starts with, or None if
    the bytes are not one complete, unambiguous PageHeader (see _ThriftCompact.page_header)."""
    try:
        return _ThriftCompact(buf).page_header()
    except (_ShortHeader, ValueError, RecursionError):
        return None


def _peek_page_header(peek: Callable[[int, int], bytes], offset: int) -> tuple[int, int] | None:
    buf = peek(offset, PAGE_HEADER_PEEK)
    for attempt in range(2):
        try:
            return _ThriftCompact(buf).page_header()
        except (ValueError, RecursionError):
            return None
        except _ShortHeader:
            if attempt or len(buf) < PAGE_HEADER_PEEK:
                return None  # larger than PAGE_HEADER_MAX, or the file ends inside the header
            buf = peek(offset, PAGE_HEADER_MAX)
    return None


def _footer_uncompressed(group: Any, leaves: list[int]) -> int:
    """Footer-declared uncompressed bytes of the selected chunks: only an average hint, never a memory bound."""
    return int(sum(group.column(k).total_uncompressed_size for k in leaves))


def _dictionary_page_size(chunk: Any, peek: Callable[[int, int], bytes]) -> int | None:
    """Size of the dictionary page the decoder will use (max of the header's uncompressed and compressed sizes), from the page header it actually reads
    first (0: the chunk starts with a data page and declares no dictionary; None: unreadable or inconsistent, so
    the column is never decoded). The header, not the footer, is what the decoder allocates from.

    The decoder (parquet-cpp ComputeColumnChunkRange) starts the chunk at data_page_offset, or at
    dictionary_page_offset when the chunk declares a dictionary page and 0 < dictionary_page_offset <
    data_page_offset. The header is peeked at that same offset, so a footer that points dictionary_page_offset at
    a fake tiny header while data_page_offset points at the real dictionary page is sized by the real page."""
    data_offset = chunk.data_page_offset
    if data_offset is None or data_offset < 0:
        return None
    declared = bool(chunk.has_dictionary_page)
    dict_offset = chunk.dictionary_page_offset if declared else None
    start = int(data_offset)
    if dict_offset is not None and 0 < dict_offset < start:
        start = int(dict_offset)
    header = _peek_page_header(peek, start)
    if header is None:
        return None
    page_type, size = header
    if page_type == _DICTIONARY_PAGE:
        return size
    if page_type not in (_DATA_PAGE, _DATA_PAGE_V2):
        return (
            None  # INDEX_PAGE or unknown: the decoder skips it, so the page it really starts with is unseen
        )
    # a declared dictionary page that is not where the decoder starts: footer and pages disagree
    return None if declared else 0


def _fit_first_batch(
    meta: Any, cols: list[_Column], read_slots: list[int], leaves: list[int], budget: int
) -> None:
    """Read fewer columns rather than fail: keep the longest prefix of decodable columns whose estimated
    first-batch fetch fits `budget`; the rest are profiled as kind "other" (not decoded)."""
    group = next((meta.row_group(g) for g in range(meta.num_row_groups) if meta.row_group(g).num_rows), None)
    if group is None:
        return
    used = 0
    for n, k in enumerate(leaves):
        used += min(group.column(k).total_compressed_size, PARQUET_FIRST_BATCH_COST)
        if used > budget and n > 0:
            for slot in read_slots[n:]:
                cols[slot].decoded = False
            del read_slots[n:], leaves[n:]
            return


def _profile_parquet(
    source: BinaryIO,
    failure: Callable[[], BaseException | None],
    hints: dict[str, FieldHint],
    limits: PreviewLimits,
    deadline: Deadline,
    footer_read: Callable[[], None] = lambda: None,
    peek: Callable[[int, int], bytes] = lambda offset, n: b"",
) -> ProfileResult:
    import pyarrow as pa
    import pyarrow.parquet as pq

    def classify(exc: Exception) -> BaseException:
        stored = failure()
        if stored is not None:
            return stored  # the storage source failed: re-raise that, never "corrupt"
        if isinstance(exc, _FetchBudgetSpent):
            return Unparseable("fetch budget spent before any row was decoded")
        if isinstance(exc, PreviewTimeout | Unparseable) or not _is_corrupt(exc):
            return exc
        return Unparseable(str(exc))

    try:
        pf = pq.ParquetFile(source, buffer_size=PARQUET_STREAM_BUFFER, pre_buffer=False)
        schema = pf.schema_arrow
        meta = pf.metadata
    except Exception as exc:
        raise classify(exc) from exc
    footer_read()  # the fetch budget covers data pages; the footer is bounded by pyarrow's thrift size limits
    n_fields = len(schema)
    columns_truncated = n_fields > limits.max_columns
    cols: list[_Column] = []
    read_slots: list[int] = []  # positions in `cols` that are decoded
    leaves: list[int] = []  # their parquet leaf column indices (duplicate names are fine)
    leaf = 0
    for i in range(min(n_fields, limits.max_columns)):
        f = schema.field(i)
        declared = next((t for check, t in _ARROW_TYPES if getattr(pa.types, check)(f.type)), "string")
        hint = hints.get(f.name, FieldHint())
        cols.append(
            _make_column(
                f.name,
                FieldHint(hint.type or declared, hint.unit, hint.description, hint.concept_iri),
                limits,
            )
        )
        if _readable(f.type):
            read_slots.append(len(cols) - 1)
            leaves.append(leaf)
        else:
            cols[-1].decoded = False
        leaf += _leaf_count(f.type)
    _fit_first_batch(meta, cols, read_slots, leaves, limits.max_bytes)
    # variable-width columns are read dictionary-encoded where possible, so one huge dictionary entry referenced
    # by every row is never densified (dictionary-expansion bomb); duplicate names cannot be selected by name
    names = list(schema.names)
    variable = {
        slot
        for slot in read_slots
        if pa.types.is_string(schema.field(slot).type) or pa.types.is_large_string(schema.field(slot).type)
    }
    as_dictionary = sorted({names[slot] for slot in variable if names.count(names[slot]) == 1})
    dense_variable = {slot for slot in variable if names[slot] not in as_dictionary}
    try:
        if as_dictionary:
            pf = pq.ParquetFile(
                source,
                metadata=meta,
                read_dictionary=as_dictionary,
                buffer_size=PARQUET_STREAM_BUFFER,
                pre_buffer=False,
            )
    except Exception as exc:
        raise classify(exc) from exc
    rng = random.Random(0)
    rows: list[list[str | None]] = []
    sampled, truncated = 0, False
    decoded = 0  # decoded Arrow bytes against max_bytes (fetched bytes are bounded by profile_table's reader)
    try:
        for rg in range(meta.num_row_groups):
            deadline()
            if sampled >= limits.max_rows or truncated:
                break  # row-cap truncation follows from num_rows below
            group = meta.row_group(rg)
            if group.num_rows == 0:
                continue
            # dictionary pages are sized from their page headers before anything is decoded
            cell_bound, oversized = 0, []
            for n, k in enumerate(leaves):
                size = _dictionary_page_size(group.column(k), peek)
                if size is None or size > limits.max_bytes // 4:
                    oversized.append(n)
                elif size == 0 and read_slots[n] in dense_variable:
                    # a densified column without a leading dictionary page: a dictionary page after its data
                    # pages would still be used by the decoder but cannot be sized without walking every page
                    oversized.append(n)
                elif size and read_slots[n] in dense_variable:
                    cell_bound += size  # a dense cell can be as large as the largest dictionary entry
            if oversized and sampled:
                truncated = True
                break
            for n in reversed(oversized):  # nothing sampled yet: profile these as "other" instead of failing
                cols[read_slots[n]].decoded = False
                del read_slots[n], leaves[n]
            if not leaves:  # nothing decodable: count rows from the metadata only
                take = min(group.num_rows, limits.max_rows - sampled)
                sampled += take
                rows.extend([None] * len(cols) for _ in range(min(take, limits.preview_rows - len(rows))))
                continue
            # rows per batch from the average decoded row size; pages are streamed (buffer_size), so a large row
            # group is read in slices instead of whole column chunks
            per_row = max(1, _footer_uncompressed(group, leaves) // group.num_rows)
            batch_rows = max(1, min(PARQUET_BATCH_ROWS, limits.max_bytes // (8 * per_row)))
            if cell_bound:  # densified dictionary columns: bound by the page headers, not the footer average
                batch_rows = max(1, min(batch_rows, limits.max_bytes // (2 * cell_bound)))
            while True:
                restart = False
                for batch in pf.reader.iter_batches(batch_rows, [rg], column_indices=leaves):
                    deadline()
                    if batch.nbytes > limits.max_bytes:  # skewed rows (or a lying footer)
                        if sampled == 0 and batch.num_rows > 1:
                            batch_rows, restart = 1, True  # retry the first rows one at a time
                            break
                        if sampled == 0:
                            raise Unparseable("a single decoded row exceeds the byte budget")
                        truncated = True
                        break
                    if sampled and decoded + batch.nbytes > limits.max_bytes:
                        truncated = True  # sample byte budget spent (like CSV max_bytes)
                        break
                    decoded += batch.nbytes
                    take = min(batch.num_rows, limits.max_rows - sampled)
                    data = [_column_values(batch.column(k).slice(0, take)) for k in range(batch.num_columns)]
                    for r in range(take):
                        sampled += 1
                        values: list[str | None] = [None] * len(cols)
                        for slot, column in zip(read_slots, data, strict=True):
                            text, nonfinite = _parquet_value(column[r])
                            values[slot] = text
                            _observe(cols[slot], text, limits, rng, nonfinite)
                        if len(rows) < limits.preview_rows:
                            rows.append([_cell(v, limits) for v in values])
                    if sampled >= limits.max_rows:
                        break
                if not restart:
                    break
    except _FetchBudgetSpent as exc:
        if sampled == 0:
            raise Unparseable("nothing decodable within the fetch budget") from exc
        truncated = True
    except Exception as exc:
        raise classify(exc) from exc
    if not truncated and meta.num_rows > sampled:
        truncated = True
    return _finish(
        "parquet",
        cols,
        rows,
        sampled,
        truncated,
        columns_truncated,
        limits,
        parquet_total_rows(meta.num_rows, sampled, truncated),
    )


def parquet_total_rows(num_rows: Any, sampled: int, truncated: bool) -> int | None:
    """The footer's row count is untrusted input: a full read reports what was decoded; otherwise the footer count
    (never below the decoded rows), or None when it is negative, not an int or beyond MAX_TOTAL_ROWS. A hostile
    footer therefore never fails an otherwise good preview."""
    if not truncated:
        return sampled
    if isinstance(num_rows, bool) or not isinstance(num_rows, int) or num_rows < 0:
        return None
    total = max(num_rows, sampled)
    return total if total <= MAX_TOTAL_ROWS else None


def profile_table(
    open_range: Callable[[int, int], BinaryIO],
    size: int,
    *,
    path: str,
    hints: dict[str, FieldHint],
    limits: PreviewLimits,
    deadline: Deadline,
) -> ProfileResult:
    """Raises Unparseable (not a readable table), PreviewTimeout (deadline), or the storage error itself."""
    fmt = table_format(path)
    if fmt is None:
        raise ValueError(f"not a tabular file: {path}")
    if size == 0:
        raise Unparseable
    if fmt == "parquet":
        fetched = [0]
        armed = [False]  # the footer is bounded by pyarrow's thrift limits; the budget covers the data pages

        def arm() -> None:
            fetched[0], armed[0] = 0, True

        def counted(start: int, end: int) -> BinaryIO:
            fetched[0] += end - start + 1
            return open_range(start, end)

        def fetch_deadline() -> None:  # runs before every ranged read
            deadline()
            if armed[0] and fetched[0] > PARQUET_FETCH_FACTOR * limits.max_bytes:
                raise _FetchBudgetSpent

        source = open_parquet_range(counted, size, deadline=fetch_deadline)
        raw = getattr(source, "raw", None)

        peeked = [0]

        def peek(offset: int, n: int) -> bytes:  # page headers: small reads outside the data-page budget
            deadline()
            if peeked[0] + n > limits.max_bytes:
                return b""  # header budget spent: the column is "other" (or the sample is truncated)
            peeked[0] += n
            end = min(size, offset + n) - 1
            if offset >= size or end < offset:
                return b""
            stream = open_range(offset, end)
            try:
                return bytes(stream.read(end - offset + 1))
            finally:
                stream.close()

        return _profile_parquet(
            source,
            lambda: getattr(raw, "failure", None),
            hints,
            limits,
            deadline,
            footer_read=arm,
            peek=peek,
        )
    stream = open_range(0, size - 1)
    try:
        return _profile_delimited(stream, fmt, hints, limits, deadline)
    finally:
        stream.close()
