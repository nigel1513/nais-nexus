"""Bounded column profiling for the Data Explorer (Wave 1.5 spec §7). Hostile-file rules follow 09 §1.4:
every read is capped and checks the deadline, physical lines are capped, sample rows/bytes are capped.

column_profile = metadata-visible (no raw values). preview = raw-value-bearing (download permission only).
Histograms are computed from a deterministic reservoir sample (≤ 2,000 values per column); min/max/mean are exact
over the sample rows. The preview JSON never exceeds `preview_bytes`: rows are dropped from the end first
(`rows_truncated`), then the distributions (`columns: []`, ruling P17), then over-long header names are shortened.
column_profile is bounded too: names/units/descriptions are cut to `cell_chars`, and a profile over `profile_bytes`
degrades (descriptions, then units/IRIs dropped, then names cut to 64) before it is Unparseable. Non-finite floats: NaN is missing (like the CSV token "NaN"); ±inf is a present
value that is excluded from min/max/mean/histogram and from top values. Parquet nested and binary columns are never
decoded: they are profiled as kind "other" with no values."""

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


@dataclass
class ProfileResult:
    format: str
    rows_sampled: int
    truncated: bool
    columns_truncated: bool
    column_profile: list[dict[str, Any]]
    preview: dict[str, Any]


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
        fmt, sampled, truncated, columns_truncated, profile, _fit_preview(preview, limits.preview_bytes)
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
    return _finish(fmt, cols, rows, sampled, truncated, columns_truncated, limits)


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


def _parquet_value(value: Any) -> tuple[str | None, bool]:
    """(text, non-finite). NaN is missing; ±inf is present but non-finite."""
    if value is None:
        return None, False
    if isinstance(value, float) and not math.isfinite(value):
        return (None, False) if math.isnan(value) else (str(value), True)
    return str(value), False


def _profile_parquet(
    source: BinaryIO,
    failure: Callable[[], BaseException | None],
    hints: dict[str, FieldHint],
    limits: PreviewLimits,
    deadline: Deadline,
) -> ProfileResult:
    import pyarrow as pa
    import pyarrow.parquet as pq

    def classify(exc: Exception) -> BaseException:
        stored = failure()
        if stored is not None:
            return stored  # the storage source failed: re-raise that, never "corrupt"
        if isinstance(exc, PreviewTimeout | Unparseable) or not _is_corrupt(exc):
            return exc
        return Unparseable(str(exc))

    try:
        pf = pq.ParquetFile(source)
        schema = pf.schema_arrow
        meta = pf.metadata
    except Exception as exc:
        raise classify(exc) from exc
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
    rng = random.Random(0)
    rows: list[list[str | None]] = []
    sampled, truncated = 0, False
    fetched = decoded = 0  # compressed chunk bytes fetched / decoded Arrow bytes, both against max_bytes
    try:
        for rg in range(meta.num_row_groups):
            deadline()
            if sampled >= limits.max_rows or truncated:
                break  # row-cap truncation follows from num_rows below
            group = meta.row_group(rg)
            if group.num_rows == 0:
                continue
            if not leaves:  # nothing decodable: count rows from the metadata only
                take = min(group.num_rows, limits.max_rows - sampled)
                sampled += take
                rows.extend([None] * len(cols) for _ in range(min(take, limits.preview_rows - len(rows))))
                continue
            chunk_bytes = sum(group.column(k).total_compressed_size for k in leaves)
            raw_bytes = max(1, sum(group.column(k).total_uncompressed_size for k in leaves))
            if fetched + chunk_bytes > limits.max_bytes:  # the selected chunks are fetched whole
                if sampled == 0:
                    raise Unparseable("first row group exceeds the byte budget")
                truncated = True
                break
            fetched += chunk_bytes
            # one decoded row can never be larger than the uncompressed chunks (a dictionary entry lives in
            # them too), so this batch size keeps every batch within half the budget when the metadata is honest
            batch_rows = max(1, min(PARQUET_BATCH_ROWS, limits.max_bytes // (2 * raw_bytes)))
            for batch in pf.reader.iter_batches(batch_rows, [rg], column_indices=leaves):
                deadline()
                if batch.nbytes > limits.max_bytes:  # the metadata lied about the decoded size
                    raise Unparseable("decoded batch exceeds the byte budget")
                if sampled and decoded + batch.nbytes > limits.max_bytes:
                    truncated = True  # sample byte budget spent (like CSV max_bytes)
                    break
                decoded += batch.nbytes
                take = min(batch.num_rows, limits.max_rows - sampled)
                data = [batch.column(k).slice(0, take).to_pylist() for k in range(batch.num_columns)]
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
    except Exception as exc:
        raise classify(exc) from exc
    if not truncated and meta.num_rows > sampled:
        truncated = True
    return _finish("parquet", cols, rows, sampled, truncated, columns_truncated, limits)


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
        source = open_parquet_range(open_range, size, deadline=deadline)
        raw = getattr(source, "raw", None)
        return _profile_parquet(source, lambda: getattr(raw, "failure", None), hints, limits, deadline)
    stream = open_range(0, size - 1)
    try:
        return _profile_delimited(stream, fmt, hints, limits, deadline)
    finally:
        stream.close()
