"""Bounded column profiling for the Data Explorer (Wave 1.5 spec §7). Hostile-file rules follow 09 §1.4:
every read is capped and checks the deadline, physical lines are capped, sample rows/bytes are capped.

column_profile = metadata-visible (no raw values). preview = raw-value-bearing (download permission only).
Histograms are computed from a deterministic reservoir sample (≤ 2,000 values per column); min/max/mean are exact
over the sample rows. The preview JSON never exceeds `preview_bytes`: rows are dropped from the end first
(`rows_truncated`), then the distributions (`columns: []`, ruling P17), then over-long header names are shortened."""

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
LINE_CAP = 1 << 20
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


def _observe(col: _Column, value: str | None, limits: PreviewLimits, rng: random.Random) -> None:
    col.seen += 1
    if value is None or value in MISSING:
        col.missing += 1
        return
    if not col.distinct_capped:
        col.distinct.add(hash(value))
        if len(col.distinct) > limits.distinct_cap:
            col.distinct_capped = True
            col.distinct.clear()  # the count is reported as the cap from here on
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
            "lower": round((lo_half + i * step_half) * 2, 6),
            "upper": round((lo_half + (i + 1) * step_half) * 2, 6) if i < bins - 1 else col.high,
            "count": round(c * scale),
        }
        for i, c in enumerate(counts)
    ]
    out[-1]["count"] += col.n_numeric - sum(b["count"] for b in out)  # keep the total exact after scaling
    return out


def _distribution(col: _Column, ctype: str, limits: PreviewLimits) -> dict[str, Any]:
    if ctype in ("integer", "number") and col.n_numeric:
        mean = col.total / col.n_numeric
        return {
            "name": col.name[: limits.cell_chars],
            "kind": "numeric",
            "min": col.low,
            "max": col.high,
            "mean": round(mean, 6) if math.isfinite(mean) else None,
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
    preview: dict[str, Any] = {
        "header": [c.name[: limits.cell_chars] for c in cols],
        "rows": rows,
        "rows_truncated": False,
        "columns": dists,
    }
    return ProfileResult(
        fmt, sampled, truncated, columns_truncated, profile, _fit_preview(preview, limits.preview_bytes)
    )


def _profile_delimited(
    stream: BinaryIO, fmt: str, hints: dict[str, FieldHint], limits: PreviewLimits, deadline: Deadline
) -> ProfileResult:
    text = io.TextIOWrapper(io.BufferedReader(CappedRaw(stream, deadline)), encoding="utf-8-sig", newline="")
    lines = BoundedLines(text, max(1, min(limits.max_bytes, LINE_CAP)))
    reader = csv.reader(lines, delimiter="\t" if fmt == "tsv" else ",")
    rng = random.Random(0)
    try:
        deadline()
        try:
            header = next(reader)
        except (StopIteration, csv.Error) as exc:
            raise Unparseable from exc
        if lines.overflow or not header:
            raise Unparseable
        columns_truncated = len(header) > limits.max_columns
        names = header[: limits.max_columns]
        cols = [_Column(n, hints.get(n, FieldHint())) for n in names]
        lines.bytes = 0  # the byte budget covers data lines only
        rows: list[list[str | None]] = []
        sampled, truncated = 0, False
        while True:
            deadline()
            row: list[str] | None
            try:
                row = next(reader)
            except StopIteration:
                break
            except csv.Error:
                row = None  # e.g. a field over the csv field limit: skipped like a malformed row
            if lines.overflow:
                raise Unparseable
            if not row:
                continue
            if sampled >= limits.max_rows or lines.bytes > limits.max_bytes:
                truncated = True
                break
            if len(row) != len(header):
                continue  # malformed row: readiness reports it; the explorer skips it
            sampled += 1
            for col, value in zip(cols, row, strict=False):
                _observe(col, value, limits, rng)
            if len(rows) < limits.preview_rows:
                rows.append([_cell(v, limits) for v in row[: limits.max_columns]])
        if lines.overflow:  # ruling P1: an over-long line ends the iterator; never READY with a partial read
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
        if isinstance(exc, PreviewTimeout) or not _is_corrupt(exc):
            return exc
        return Unparseable(str(exc))

    try:
        pf = pq.ParquetFile(source)
        schema = pf.schema_arrow
    except Exception as exc:
        raise classify(exc) from exc
    names = list(schema.names)
    columns_truncated = len(names) > limits.max_columns
    indices = list(range(min(len(names), limits.max_columns)))
    cols = []
    for i in indices:
        arrow_type = schema.field(i).type
        declared = next((t for check, t in _ARROW_TYPES if getattr(pa.types, check)(arrow_type)), "string")
        hint = hints.get(names[i], FieldHint())
        cols.append(
            _Column(names[i], FieldHint(hint.type or declared, hint.unit, hint.description, hint.concept_iri))
        )
    rng = random.Random(0)
    rows: list[list[str | None]] = []
    sampled, truncated, consumed = 0, False, 0
    try:
        for batch in pf.iter_batches(batch_size=PARQUET_BATCH_ROWS):
            deadline()
            if sampled >= limits.max_rows or consumed >= limits.max_bytes:
                truncated = True
                break
            consumed += batch.nbytes
            take = min(batch.num_rows, limits.max_rows - sampled)
            if take < batch.num_rows:
                truncated = True
            data = [batch.column(i).slice(0, take).to_pylist() for i in indices]
            for r in range(take):
                sampled += 1
                values = [None if column[r] is None else str(column[r]) for column in data]
                for col, value in zip(cols, values, strict=True):
                    _observe(col, value, limits, rng)
                if len(rows) < limits.preview_rows:
                    rows.append([_cell(v, limits) for v in values])
            if truncated:
                break
    except Exception as exc:
        raise classify(exc) from exc
    if not truncated and pf.metadata.num_rows > sampled:
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
