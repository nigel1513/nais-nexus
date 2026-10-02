"""Recipe steps on pyarrow tables (spec §5.3). Pure functions: no I/O, no database, no logging of values.

`plan` walks the steps over input *schemas* and returns the result schema, raising StepError for the first step
that does not fit (unknown column, type mismatch, bad value, join input outside the recipe). `apply` plans against
the actual tables' schemas, then executes step by step. Errors never carry data values: messages name the step,
the column and the types involved only (pyarrow's own messages quote values and are never passed on).

Type families (`family`): integer, float (floating point and decimal), bool, string, datetime (timestamp, date) and
other (binary, nested, null). Comparisons treat missing values as "no match"; NaN counts as missing.
Result column names: aggregate metrics are `<column>_<fn>`; join columns that collide get the suffix `_right`.
Ordering is deterministic: single-threaded group-by/join, stable sort.
"""

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID

import pyarrow as pa
import pyarrow.compute as pc

from api.modules.workspace.recipes.model import (
    Aggregate,
    CastType,
    ConvertUnit,
    DropMissing,
    FillMissing,
    FilterRows,
    Join,
    Limit,
    SelectColumns,
    Sort,
    Step,
)

CELL_CHARS = 200
INT64_LIMIT = float(2**63)
JOIN_SUFFIX = "_right"
_OFFSET = r"[T ]\d{2}(:?\d{2})?.*(Z|z|[+-]\d{2}(:?\d{2})?)$"  # a time part followed by a zone
_CAST_TARGET: dict[str, pa.DataType] = {
    "int": pa.int64(),
    "float": pa.float64(),
    "string": pa.string(),
    "bool": pa.bool_(),
    "datetime": pa.timestamp("us", "UTC"),
}
# cast_type: target -> source families it accepts
_CASTABLE: dict[str, frozenset[str]] = {
    "int": frozenset({"integer", "float", "bool", "string"}),
    "float": frozenset({"integer", "float", "bool", "string"}),
    "string": frozenset({"integer", "float", "bool", "string", "datetime"}),
    "bool": frozenset({"integer", "float", "bool", "string"}),
    "datetime": frozenset({"string", "datetime"}),
}
_ORDERED = frozenset({"integer", "float", "string", "datetime"})
_NUMERIC = frozenset({"integer", "float"})


@dataclass
class StepError(Exception):
    """A step that does not fit its input. step_index None: the problem is an input, not a step."""

    step_index: int | None
    reason: (
        str  # UNKNOWN_COLUMN | TYPE_MISMATCH | INVALID_VALUE | DUPLICATE_COLUMN | UNKNOWN_INPUT | CAST_FAILED
    )
    message: str  #  | TOO_MANY_ROWS | INPUT_NOT_TABULAR | INPUT_UNREADABLE ...; never contains data values
    column: str | None = None
    input_id: UUID | None = None

    def __str__(self) -> str:
        return self.message

    def details(self) -> dict[str, Any]:
        out: dict[str, Any] = {"step_index": self.step_index, "reason": self.reason}
        if self.column is not None:
            out["column"] = self.column
        if self.input_id is not None:
            out["input_id"] = str(self.input_id)
        return out


def family(dtype: pa.DataType) -> str:
    if pa.types.is_integer(dtype):
        return "integer"
    if pa.types.is_floating(dtype) or pa.types.is_decimal(dtype):
        return "float"
    if pa.types.is_boolean(dtype):
        return "bool"
    if pa.types.is_string(dtype) or pa.types.is_large_string(dtype):
        return "string"
    if pa.types.is_timestamp(dtype) or pa.types.is_date(dtype):
        return "datetime"
    return "other"


_LABEL = {
    "integer": "an integer",
    "float": "a number",
    "bool": "a boolean",
    "string": "text",
    "datetime": "a date/time",
    "other": "an unsupported type",
}


def needed_inputs(steps: Sequence[Step], input_ids: Sequence[UUID]) -> list[UUID]:
    """The base input (first id) and every input a join step reads, in input_ids order."""
    joined = {s.right_input_id for s in steps if isinstance(s, Join)}
    return [i for n, i in enumerate(input_ids) if n == 0 or i in joined]


# ---------------------------------------------------------------- planning


class _Planner:
    def __init__(self, index: int, step: Step, schema: pa.Schema) -> None:
        self.index = index
        self.step = step
        self.schema = schema

    def fail(
        self, reason: str, message: str, column: str | None = None, input_id: UUID | None = None
    ) -> StepError:
        return StepError(
            self.index, reason, f"Step {self.index + 1} ({self.step.type}): {message}", column, input_id
        )

    def field(self, name: str, schema: pa.Schema | None = None, where: str = "") -> pa.Field:
        schema = schema if schema is not None else self.schema
        idx = schema.get_field_index(name)
        if idx < 0:
            raise self.fail("UNKNOWN_COLUMN", f"column '{name}' does not exist{where}.", name)
        return schema.field(idx)

    def fam(self, name: str) -> str:
        return family(self.field(name).type)

    def require(self, name: str, allowed: frozenset[str], need: str) -> str:
        fam = self.fam(name)
        if fam not in allowed:
            raise self.fail("TYPE_MISMATCH", f"column '{name}' is {_LABEL[fam]}; {need}.", name)
        return fam


def _value_fits(fam: str, value: Any, *, exact: bool = False) -> bool:
    """Can a JSON literal stand for a value of this family? exact: integers only for integer columns."""
    if fam == "integer":
        return (
            isinstance(value, int) and not isinstance(value, bool) or (not exact and isinstance(value, float))
        )
    if fam == "float":
        return isinstance(value, int | float) and not isinstance(value, bool)
    if fam == "bool":
        return isinstance(value, bool)
    if fam == "string":
        return isinstance(value, str)
    if fam == "datetime":
        return isinstance(value, str) and _parse_datetime(value) is not None
    return False


def _parse_datetime(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value.strip())
    except ValueError:
        return None


def _plan_filter(p: _Planner, s: FilterRows) -> pa.Schema:
    fam = p.fam(s.column)
    if s.op in ("is_null", "not_null"):
        if s.value is not None:
            raise p.fail("INVALID_VALUE", f"'{s.op}' takes no value.", s.column)
        return p.schema
    if s.value is None:
        raise p.fail("INVALID_VALUE", f"'{s.op}' needs a value.", s.column)
    if s.op == "contains":
        p.require(s.column, frozenset({"string"}), "'contains' needs a text column")
        if not isinstance(s.value, str):
            raise p.fail("INVALID_VALUE", "'contains' needs a text value.", s.column)
        return p.schema
    if fam == "other":
        raise p.fail("TYPE_MISMATCH", f"column '{s.column}' has a type that cannot be compared.", s.column)
    if s.op in ("lt", "le", "gt", "ge") and fam not in _ORDERED:
        raise p.fail("TYPE_MISMATCH", f"column '{s.column}' is {_LABEL[fam]} and has no order.", s.column)
    if s.op == "in" and (not isinstance(s.value, list) or not s.value):
        raise p.fail("INVALID_VALUE", "'in' needs a non-empty list of values.", s.column)
    if s.op != "in" and isinstance(s.value, list):
        raise p.fail("INVALID_VALUE", f"'{s.op}' needs a single value, not a list.", s.column)
    values: list[Any] = s.value if isinstance(s.value, list) else [s.value]
    for value in values:
        if fam == "datetime" and isinstance(value, str) and _parse_datetime(value) is None:
            raise p.fail("INVALID_VALUE", "the value is not an ISO 8601 date/time.", s.column)
        if not _value_fits(fam, value):
            raise p.fail(
                "TYPE_MISMATCH", f"column '{s.column}' is {_LABEL[fam]}; the value is not.", s.column
            )
    return p.schema


def _plan_aggregate(p: _Planner, s: Aggregate) -> pa.Schema:
    fields = [p.field(g) for g in s.group_by]
    for f in fields:
        if family(f.type) == "other":
            raise p.fail("TYPE_MISMATCH", f"column '{f.name}' cannot be grouped by.", f.name)
    names = [f.name for f in fields]
    out = list(fields)
    for m in s.metrics:
        fam = p.fam(m.column)
        source = p.field(m.column).type
        if m.fn in ("sum", "mean"):
            p.require(m.column, _NUMERIC, f"'{m.fn}' needs a numeric column")
        if m.fn in ("min", "max") and fam not in _ORDERED | {"bool"}:
            raise p.fail("TYPE_MISMATCH", f"column '{m.column}' has no order for '{m.fn}'.", m.column)
        name = f"{m.column}_{m.fn}"
        if name in names:
            raise p.fail("DUPLICATE_COLUMN", f"the result column '{name}' would appear twice.", name)
        names.append(name)
        if m.fn == "count":
            dtype = pa.int64()
        elif m.fn == "mean":
            dtype = pa.float64()
        elif m.fn == "sum":
            dtype = pa.int64() if fam == "integer" else pa.float64()
        else:  # min/max keep the type; decimals are aggregated as float64
            dtype = pa.float64() if pa.types.is_decimal(source) else source
        out.append(pa.field(name, dtype))
    return pa.schema(out)


def join_names(left: Sequence[str], right: Sequence[str], keys: Sequence[str]) -> list[str]:
    """Result names of the joined input's non-key columns (in order): a name already taken gets `_right`.
    Raises ValueError(name) when even the suffixed name is taken. Shared by planning and execution."""
    taken = set(left)
    names: list[str] = []
    for n in right:
        if n in keys:
            continue
        name = n if n not in taken else f"{n}{JOIN_SUFFIX}"
        if name in taken:
            raise ValueError(name)
        taken.add(name)
        names.append(name)
    return names


def join_key_type(left: pa.DataType, right: pa.DataType) -> pa.DataType:
    """The type both key columns are cast to: the wider integer / the large string (same family planned)."""
    if left == right:
        return left
    if pa.types.is_integer(left) and pa.types.is_integer(right):
        if pa.types.is_signed_integer(left) == pa.types.is_signed_integer(right):
            return left if left.bit_width >= right.bit_width else right
        return pa.int64()
    if pa.types.is_large_string(left) or pa.types.is_large_string(right):
        return pa.large_string()
    return left


def _plan_join(
    p: _Planner, s: Join, schemas: Mapping[UUID, pa.Schema], input_ids: Sequence[UUID]
) -> pa.Schema:
    if s.right_input_id not in input_ids or s.right_input_id not in schemas:
        raise p.fail(
            "UNKNOWN_INPUT", "the joined input is not one of the recipe's inputs.", input_id=s.right_input_id
        )
    right = schemas[s.right_input_id]
    for key in s.on:
        left_type = p.field(key).type
        right_type = p.field(key, right, " in the joined input").type
        lf, rf = family(left_type), family(right_type)
        if lf != rf or lf == "other" or (lf in ("datetime", "float") and left_type != right_type):
            raise p.fail(
                "TYPE_MISMATCH",
                f"key '{key}' is {_LABEL[lf]} on the left and {_LABEL[rf]} in the joined input; cast one first.",
                key,
            )
    try:
        names = join_names(p.schema.names, right.names, s.on)
    except ValueError as exc:
        name = str(exc)
        raise p.fail("DUPLICATE_COLUMN", f"the result column '{name}' would appear twice.", name) from exc
    out = [
        pa.field(f.name, join_key_type(f.type, right.field(f.name).type), metadata=f.metadata)
        if f.name in s.on
        else f
        for f in p.schema
    ]
    payload = [f for f in right if f.name not in s.on]
    out += [pa.field(n, f.type, metadata=f.metadata) for n, f in zip(names, payload, strict=True)]
    return pa.schema(out)


def _plan_step(p: _Planner, schemas: Mapping[UUID, pa.Schema], input_ids: Sequence[UUID]) -> pa.Schema:
    s = p.step
    schema = p.schema
    match s:
        case SelectColumns():
            return pa.schema([p.field(c) for c in s.columns])
        case FilterRows():
            return _plan_filter(p, s)
        case DropMissing():
            for c in s.columns or []:
                p.field(c)
            return schema
        case FillMissing():
            fam = p.fam(s.column)
            if not _value_fits(fam, s.value, exact=True):
                raise p.fail(
                    "TYPE_MISMATCH", f"column '{s.column}' is {_LABEL[fam]}; the value is not.", s.column
                )
            return schema
        case CastType():
            fam = p.fam(s.column)
            if fam not in _CASTABLE[s.to]:
                raise p.fail(
                    "TYPE_MISMATCH",
                    f"column '{s.column}' is {_LABEL[fam]} and cannot become {s.to}.",
                    s.column,
                )
            idx = schema.get_field_index(s.column)
            return schema.set(idx, pa.field(s.column, _CAST_TARGET[s.to]))
        case ConvertUnit():
            p.require(s.column, _NUMERIC, "unit conversion needs a numeric column")
            idx = schema.get_field_index(s.column)
            return schema.set(idx, pa.field(s.column, pa.float64(), metadata={"unit": s.unit_label}))
        case Aggregate():
            return _plan_aggregate(p, s)
        case Join():
            return _plan_join(p, s, schemas, input_ids)
        case Sort():
            for c in s.by:
                if p.fam(c) not in _ORDERED | {"bool"}:
                    raise p.fail("TYPE_MISMATCH", f"column '{c}' cannot be sorted.", c)
            return schema
        case Limit():
            return schema
    raise AssertionError(f"unknown step {s!r}")  # pragma: no cover


def plan(steps: Sequence[Step], schemas: Mapping[UUID, pa.Schema], input_ids: Sequence[UUID]) -> pa.Schema:
    """The result schema of the steps over the inputs' schemas (first input id = base table)."""
    _check_input_schemas(schemas)
    schema = schemas[input_ids[0]]
    for index, step in enumerate(steps):
        schema = _plan_step(_Planner(index, step, schema), schemas, input_ids)
    return schema


def _check_input_schemas(schemas: Mapping[UUID, pa.Schema]) -> None:
    for input_id, schema in schemas.items():
        if len(set(schema.names)) != len(schema.names):
            raise StepError(
                None, "DUPLICATE_COLUMN", "An input has duplicate column names.", input_id=input_id
            )


# ---------------------------------------------------------------- execution


def _numeric(col: pa.ChunkedArray) -> pa.ChunkedArray:
    return pc.cast(col, pa.float64()) if pa.types.is_decimal(col.type) else col


def _missing(col: pa.ChunkedArray) -> pa.ChunkedArray:
    if pa.types.is_floating(col.type):
        return pc.is_null(col, nan_is_null=True)
    return pc.is_null(col)


def _literal(value: Any, dtype: pa.DataType) -> pa.Scalar:
    fam = family(dtype)
    if fam == "datetime":
        parsed = _parse_datetime(value)
        assert parsed is not None  # planned
        if pa.types.is_date(dtype):
            return pa.scalar(parsed.date(), dtype)
        if dtype.tz is not None:
            aware = parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
            return pa.scalar(aware, dtype)
        naive = parsed.astimezone(UTC).replace(tzinfo=None) if parsed.tzinfo else parsed
        return pa.scalar(naive, dtype)
    if fam == "float":
        return pa.scalar(float(value), pa.float64())
    if fam == "integer" and isinstance(value, float):
        return pa.scalar(value, pa.float64())
    if fam == "integer":
        return pa.scalar(value, pa.int64())
    return pa.scalar(value, dtype)


def _filter(table: pa.Table, s: FilterRows) -> pa.Table:
    col = table.column(s.column)
    if s.op == "is_null":
        return table.filter(_missing(col))
    if s.op == "not_null":
        return table.filter(pc.invert(_missing(col)))
    if s.op == "contains":
        return table.filter(pc.match_substring(col, s.value))
    present = pc.invert(_missing(col))
    col = _numeric(col)
    if s.op == "in":
        values = s.value if isinstance(s.value, list) else [s.value]
        if family(col.type) == "float" or any(isinstance(v, float) for v in values):
            col = pc.cast(col, pa.float64()) if family(col.type) in _NUMERIC else col
        scalars = [_literal(v, col.type) for v in values]
        value_set = pa.array([x.cast(col.type).as_py() for x in scalars], col.type)
        return table.filter(pc.and_(pc.is_in(col, value_set=value_set), present))
    fn = {
        "eq": pc.equal,
        "ne": pc.not_equal,
        "lt": pc.less,
        "le": pc.less_equal,
        "gt": pc.greater,
        "ge": pc.greater_equal,
    }[s.op]
    return table.filter(pc.and_(fn(col, _literal(s.value, col.type)), present))


def _replace(
    table: pa.Table, name: str, values: pa.ChunkedArray | pa.Array, metadata: dict[str, str] | None = None
) -> pa.Table:
    idx = table.schema.get_field_index(name)
    return table.set_column(idx, pa.field(name, values.type, metadata=metadata), values)


def _to_datetime(col: pa.ChunkedArray) -> pa.ChunkedArray:
    target = pa.timestamp("us", "UTC")
    if pa.types.is_timestamp(col.type):
        if col.type.tz is None:
            return pc.assume_timezone(pc.cast(col, pa.timestamp("us")), "UTC")
        return pc.cast(col, target)
    if pa.types.is_date(col.type):
        return pc.assume_timezone(pc.cast(col, pa.timestamp("us")), "UTC")
    text = pc.utf8_trim_whitespace(col)
    has_offset = pc.match_substring_regex(text, _OFFSET)
    null = pa.scalar(None, text.type)
    aware = pc.cast(pc.if_else(has_offset, text, null), target)
    naive = pc.assume_timezone(pc.cast(pc.if_else(has_offset, null, text), pa.timestamp("us")), "UTC")
    return pc.if_else(has_offset, aware, naive)


def _cast(col: pa.ChunkedArray, to: str) -> pa.ChunkedArray:
    if to == "datetime":
        return _to_datetime(col)
    if pa.types.is_floating(col.type) and to in ("int", "bool"):
        col = _nan_to_null(col)
    if pa.types.is_string(col.type) or pa.types.is_large_string(col.type):
        col = pc.utf8_trim_whitespace(col)
        if to == "bool":
            col = pc.utf8_lower(col)
    return pc.cast(col, _CAST_TARGET[to])


def _aggregate(table: pa.Table, s: Aggregate) -> pa.Table:
    source = table.select(list(dict.fromkeys([*s.group_by, *(m.column for m in s.metrics)])))
    for name in source.column_names:
        dtype = source.schema.field(name).type
        if pa.types.is_decimal(dtype):
            source = _replace(source, name, _numeric(source.column(name)))
        elif pa.types.is_floating(dtype):  # NaN is missing: not counted, not summed, not compared
            source = _replace(source, name, _nan_to_null(source.column(name)))
    checks = [
        m.column
        for m in s.metrics
        if m.fn == "sum" and family(source.schema.field(m.column).type) == "integer"
    ]
    for name in dict.fromkeys(checks):  # float shadow sums detect integer overflow (pyarrow sums wrap)
        shadow = pc.cast(source.column(name), pa.float64(), safe=False)  # approximate is enough here
        source = source.append_column(f"\x00{name}", shadow)
    pyarrow_fn = {"count": "count", "sum": "sum", "mean": "mean", "min": "min", "max": "max"}
    grouped = source.group_by(list(s.group_by), use_threads=False).aggregate(
        [(m.column, pyarrow_fn[m.fn]) for m in s.metrics]
        + [(f"\x00{n}", "sum") for n in dict.fromkeys(checks)]
    )
    for name in dict.fromkeys(checks):
        largest = pc.max(pc.abs(grouped.column(f"\x00{name}_sum"))).as_py()
        if largest is not None and largest >= INT64_LIMIT:
            raise OverflowError(name)
    names = [*s.group_by, *(f"{m.column}_{m.fn}" for m in s.metrics)]
    out = grouped.select(names)
    for m in s.metrics:  # an integer column's sum stays integer, everything else as planned
        if m.fn == "sum" and family(table.schema.field(m.column).type) == "float":
            out = _replace(out, f"{m.column}_sum", pc.cast(out.column(f"{m.column}_sum"), pa.float64()))
        if m.fn == "sum" and family(table.schema.field(m.column).type) == "integer":
            out = _replace(out, f"{m.column}_sum", pc.cast(out.column(f"{m.column}_sum"), pa.int64()))
    return out


def _nan_to_null(col: pa.ChunkedArray) -> pa.ChunkedArray:
    return pc.if_else(pc.is_nan(col), pa.scalar(None, col.type), col)


def _join_rows(left: pa.Table, right: pa.Table, keys: list[str], how: str) -> int:
    """Rows the join will produce, from per-key counts (null keys never match)."""
    lc = left.select(keys).group_by(keys, use_threads=False).aggregate([([], "count_all")])
    rc = right.select(keys).group_by(keys, use_threads=False).aggregate([([], "count_all")])
    lc = lc.rename_columns([*keys, "_l"])
    rc = rc.rename_columns([*keys, "_r"])
    matched = lc.join(rc, keys, join_type="inner", use_threads=False)
    products = (
        pc.sum(
            pc.multiply(pc.cast(matched.column("_l"), pa.int64()), pc.cast(matched.column("_r"), pa.int64()))
        ).as_py()
        or 0
    )
    if how == "inner":
        return int(products)
    matched_left = pc.sum(matched.column("_l")).as_py() or 0
    return int(left.num_rows - matched_left + products)


def _join(
    table: pa.Table, right: pa.Table, s: Join, max_rows: int, fail: Callable[[str, str], StepError]
) -> pa.Table:
    keys = list(s.on)
    for key in keys:  # same family was planned; both sides take the wider type
        lt, rt = table.schema.field(key).type, right.schema.field(key).type
        common = join_key_type(lt, rt)
        if lt != common:
            table = _replace(table, key, pc.cast(table.column(key), common), table.schema.field(key).metadata)
        if rt != common:
            right = _replace(right, key, pc.cast(right.column(key), common))
    expected = _join_rows(table, right, keys, s.how)
    if expected > max_rows:
        raise fail(
            "TOO_MANY_ROWS", f"the join would produce {expected:,} rows, more than the limit of {max_rows:,}."
        )
    payload = iter(join_names(table.column_names, right.column_names, keys))  # planned: no ValueError
    right = right.rename_columns([n if n in keys else next(payload) for n in right.column_names])
    joined = table.join(
        right,
        keys,
        join_type="inner" if s.how == "inner" else "left outer",
        use_threads=False,
        coalesce_keys=True,
    )
    order = [*table.column_names, *(n for n in right.column_names if n not in keys)]
    return joined.select(order)


def _apply_step(
    table: pa.Table,
    s: Step,
    tables: Mapping[UUID, pa.Table],
    max_rows: int,
    fail: Callable[[str, str], StepError],
) -> pa.Table:
    match s:
        case SelectColumns():
            return table.select(list(s.columns))
        case FilterRows():
            return _filter(table, s)
        case DropMissing():
            columns = table.column_names if s.columns is None else list(s.columns)
            keep = None
            for c in columns:
                present = pc.invert(_missing(table.column(c)))
                keep = present if keep is None else pc.and_(keep, present)
            return table if keep is None else table.filter(keep)
        case FillMissing():
            col = table.column(s.column)
            filled = pc.if_else(_missing(col), _literal(s.value, col.type).cast(col.type), col)
            return _replace(table, s.column, filled, table.schema.field(s.column).metadata)
        case CastType():
            try:
                values = _cast(table.column(s.column), s.to)
            except (pa.ArrowInvalid, pa.ArrowNotImplementedError) as exc:
                raise fail(
                    "CAST_FAILED",
                    f"some values of column '{s.column}' cannot be converted to {s.to}.",
                ) from exc
            return _replace(table, s.column, values)
        case ConvertUnit():
            col = pc.cast(table.column(s.column), pa.float64())
            converted = pc.add(pc.multiply(col, float(s.factor)), float(s.offset))
            return _replace(table, s.column, converted, {"unit": s.unit_label})
        case Aggregate():
            try:
                return _aggregate(table, s)
            except OverflowError as exc:
                raise fail(
                    "STEP_FAILED",
                    f"the sum of column '{exc.args[0]}' is outside the integer range; cast it to float.",
                ) from exc
        case Join():
            return _join(table, tables[s.right_input_id], s, max_rows, fail)
        case Sort():
            order = "descending" if s.descending else "ascending"
            return table.sort_by([(c, order) for c in s.by])
        case Limit():
            return table.slice(0, s.n)
    raise AssertionError(f"unknown step {s!r}")  # pragma: no cover


def _noop() -> None:
    return None


def apply(
    steps: Sequence[Step],
    tables: Mapping[UUID, pa.Table],
    input_ids: Sequence[UUID],
    *,
    max_rows: int,
    check: Callable[[], None] = _noop,
) -> pa.Table:
    """Plan against the tables' schemas, then run every step. `check` runs before each step (deadlines)."""
    plan(steps, {i: t.schema for i, t in tables.items()}, input_ids)
    table = tables[input_ids[0]]
    for index, step in enumerate(steps):
        check()

        def fail(reason: str, message: str, _i: int = index, _s: Step = step) -> StepError:
            column = getattr(_s, "column", None)
            return StepError(_i, reason, f"Step {_i + 1} ({_s.type}): {message}", column)

        try:
            table = _apply_step(table, step, tables, max_rows, fail)
        except StepError:
            raise
        except (pa.ArrowInvalid, pa.ArrowNotImplementedError, pa.ArrowTypeError) as exc:
            raise fail("STEP_FAILED", "the step could not be applied to these values.") from exc
        if table.num_rows > max_rows:
            raise fail("TOO_MANY_ROWS", f"the result has more than {max_rows:,} rows.")
    check()
    return table


# ---------------------------------------------------------------- preview cells


def _cell(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bool):
        text = "true" if value else "false"
    elif isinstance(value, datetime | date):
        text = value.isoformat()
    elif isinstance(value, bytes):
        text = value.hex()
    else:
        text = str(value)
    return text[:CELL_CHARS]


def preview_rows(table: pa.Table, limit: int) -> list[list[str | None]]:
    """The first `limit` rows as strings (≤ 200 characters each, None for missing)."""
    head = table.slice(0, limit)
    columns = [head.column(i).to_pylist() for i in range(head.num_columns)]
    return [[_cell(col[r]) for col in columns] for r in range(head.num_rows)]
