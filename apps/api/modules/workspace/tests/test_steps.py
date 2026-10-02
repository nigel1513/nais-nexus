"""recipes.steps: pure step planning (schema checks) and application on pyarrow tables."""

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import pyarrow as pa
import pytest
from pydantic import ValidationError

from api.modules.workspace.recipes import steps as S
from api.modules.workspace.recipes.model import parse_steps

BASE = UUID("00000000-0000-7000-8000-0000000000b1")
RIGHT = UUID("00000000-0000-7000-8000-0000000000b2")
OTHER = UUID("00000000-0000-7000-8000-0000000000b9")
IDS = [BASE, RIGHT]


def cells() -> pa.Table:
    return pa.table(
        {
            "cell_id": ["C-01", "C-01", "C-02", "C-03", None],
            "temperature_c": [25.0, 45.0, 50.0, None, 41.0],
            "cycles": pa.array([1, 2, 3, 4, 5], pa.int64()),
            "ok": [True, False, True, None, True],
            "measured_at": pa.array(
                [datetime(2026, 1, d, tzinfo=UTC) for d in (1, 2, 3, 4, 5)], pa.timestamp("us", "UTC")
            ),
            "note": ["first run", "hot", None, "cold start", "x"],
        }
    )


def specs() -> pa.Table:
    return pa.table({"cell_id": ["C-01", "C-02", "C-02"], "chemistry": ["NMC", "LFP", "LFP-b"]})


def run(
    steps: list[dict[str, Any]], base: pa.Table | None = None, right: pa.Table | None = None, **kw: Any
) -> pa.Table:
    tables = {BASE: base if base is not None else cells(), RIGHT: right if right is not None else specs()}
    return S.apply(parse_steps(steps), tables, IDS, max_rows=kw.pop("max_rows", 1_000_000), **kw)


def plan(steps: list[dict[str, Any]], base: pa.Table | None = None) -> pa.Schema:
    schemas = {BASE: (base if base is not None else cells()).schema, RIGHT: specs().schema}
    return S.plan(parse_steps(steps), schemas, IDS)


def invalid(steps: list[dict[str, Any]], base: pa.Table | None = None) -> S.StepError:
    with pytest.raises(S.StepError) as exc:
        plan(steps, base)
    return exc.value


def col(table: pa.Table, name: str) -> list[Any]:
    return table.column(name).to_pylist()


# ---------------------------------------------------------------- filter_rows: the ten operators


@pytest.mark.parametrize(
    ("op", "value", "expected"),
    [
        ("eq", 45.0, [2]),
        ("ne", 45.0, [1, 3, 5]),  # missing values never match a comparison
        ("lt", 45, [1, 5]),
        ("le", 45, [1, 2, 5]),
        ("gt", 45, [3]),
        ("ge", 41, [2, 3, 5]),
        ("in", [25, 50], [1, 3]),
        ("is_null", None, [4]),
        ("not_null", None, [1, 2, 3, 5]),
    ],
)
def test_filter_operators_on_numbers(op: str, value: Any, expected: list[int]) -> None:
    step: dict[str, Any] = {"type": "filter_rows", "column": "temperature_c", "op": op}
    if value is not None:
        step["value"] = value
    assert col(run([step]), "cycles") == expected


def test_filter_contains_and_string_comparisons() -> None:
    assert col(
        run([{"type": "filter_rows", "column": "note", "op": "contains", "value": "st"}]), "cycles"
    ) == [1, 4]
    assert col(
        run([{"type": "filter_rows", "column": "cell_id", "op": "eq", "value": "C-02"}]), "cycles"
    ) == [3]
    assert col(
        run([{"type": "filter_rows", "column": "cell_id", "op": "in", "value": ["C-01"]}]), "cycles"
    ) == [1, 2]
    assert col(
        run([{"type": "filter_rows", "column": "cell_id", "op": "gt", "value": "C-01"}]), "cycles"
    ) == [3, 4]


def test_filter_on_booleans_and_datetimes() -> None:
    assert col(run([{"type": "filter_rows", "column": "ok", "op": "eq", "value": False}]), "cycles") == [2]
    got = run([{"type": "filter_rows", "column": "measured_at", "op": "ge", "value": "2026-01-04T00:00:00Z"}])
    assert col(got, "cycles") == [4, 5]
    # a value without an offset is read as UTC
    got = run([{"type": "filter_rows", "column": "measured_at", "op": "lt", "value": "2026-01-02"}])
    assert col(got, "cycles") == [1]


@pytest.mark.parametrize(
    ("step", "reason"),
    [
        ({"type": "filter_rows", "column": "nope", "op": "eq", "value": 1}, "UNKNOWN_COLUMN"),
        ({"type": "filter_rows", "column": "temperature_c", "op": "eq", "value": "hot"}, "TYPE_MISMATCH"),
        ({"type": "filter_rows", "column": "temperature_c", "op": "contains", "value": "4"}, "TYPE_MISMATCH"),
        ({"type": "filter_rows", "column": "temperature_c", "op": "eq"}, "INVALID_VALUE"),
        ({"type": "filter_rows", "column": "temperature_c", "op": "in", "value": 4}, "INVALID_VALUE"),
        ({"type": "filter_rows", "column": "temperature_c", "op": "in", "value": []}, "INVALID_VALUE"),
        ({"type": "filter_rows", "column": "temperature_c", "op": "is_null", "value": 4}, "INVALID_VALUE"),
        ({"type": "filter_rows", "column": "ok", "op": "gt", "value": True}, "TYPE_MISMATCH"),
        ({"type": "filter_rows", "column": "note", "op": "lt", "value": 3}, "TYPE_MISMATCH"),
        ({"type": "filter_rows", "column": "measured_at", "op": "ge", "value": "yesterday"}, "INVALID_VALUE"),
    ],
)
def test_filter_problems_name_the_step_and_reason(step: dict[str, Any], reason: str) -> None:
    error = invalid([{"type": "limit", "n": 10}, step])
    assert (error.step_index, error.reason) == (1, reason)
    assert error.details()["step_index"] == 1


def test_step_shapes_follow_the_contract() -> None:
    with pytest.raises(ValidationError):
        parse_steps([{"type": "filter_rows", "column": "a", "op": "between", "value": 1}])
    with pytest.raises(ValidationError):
        parse_steps([{"type": "limit", "n": True}])  # a boolean is not an integer
    with pytest.raises(ValidationError):
        parse_steps([{"type": "select_columns", "columns": ["a", "a"]}])
    with pytest.raises(ValidationError):
        parse_steps([{"type": "sort", "by": ["a"], "descending": False, "extra": 1}])
    with pytest.raises(ValidationError):
        parse_steps([{"type": "filter_rows", "column": "a", "op": "in", "value": [True]}])


# ---------------------------------------------------------------- select / missing values / sort / limit


def test_select_columns_keeps_the_given_order() -> None:
    got = run([{"type": "select_columns", "columns": ["note", "cell_id"]}])
    assert got.column_names == ["note", "cell_id"]
    assert invalid([{"type": "select_columns", "columns": ["cell_id", "missing"]}]).reason == "UNKNOWN_COLUMN"


def test_drop_and_fill_missing() -> None:
    assert col(run([{"type": "drop_missing", "columns": ["cell_id"]}]), "cycles") == [1, 2, 3, 4]
    assert col(run([{"type": "drop_missing", "columns": None}]), "cycles") == [1, 2]
    assert col(run([{"type": "drop_missing", "columns": []}]), "cycles") == [1, 2, 3, 4, 5]
    got = run([{"type": "fill_missing", "column": "temperature_c", "value": 0}])
    assert col(got, "temperature_c") == [25.0, 45.0, 50.0, 0.0, 41.0]
    assert col(run([{"type": "fill_missing", "column": "cell_id", "value": "?"}]), "cell_id")[-1] == "?"
    assert invalid([{"type": "fill_missing", "column": "cycles", "value": 1.5}]).reason == "TYPE_MISMATCH"
    assert invalid([{"type": "fill_missing", "column": "note", "value": 3}]).reason == "TYPE_MISMATCH"
    assert invalid([{"type": "drop_missing", "columns": ["zzz"]}]).reason == "UNKNOWN_COLUMN"


def test_nan_counts_as_missing() -> None:
    table = pa.table({"x": [1.0, float("nan"), None]})
    assert run([{"type": "drop_missing", "columns": ["x"]}], base=table).num_rows == 1
    assert col(run([{"type": "fill_missing", "column": "x", "value": 9}], base=table), "x") == [1.0, 9.0, 9.0]


def test_sort_and_limit() -> None:
    got = run([{"type": "sort", "by": ["temperature_c"], "descending": True}, {"type": "limit", "n": 2}])
    assert col(got, "cycles") == [3, 2]
    got = run([{"type": "sort", "by": ["cell_id", "cycles"], "descending": False}])
    assert col(got, "cycles") == [1, 2, 3, 4, 5]  # missing keys last
    assert invalid([{"type": "sort", "by": ["nope"], "descending": False}]).reason == "UNKNOWN_COLUMN"


# ---------------------------------------------------------------- cast_type / convert_unit


def test_cast_types() -> None:
    table = pa.table(
        {
            "s": ["1", " 2", None],
            "f": [1.0, 2.0, None],
            "d": ["2026-01-01", "2026-01-02T03:00:00+09:00", None],
        }
    )
    got = run(
        [
            {"type": "cast_type", "column": "s", "to": "int"},
            {"type": "cast_type", "column": "f", "to": "string"},
            {"type": "cast_type", "column": "d", "to": "datetime"},
        ],
        base=table,
    )
    assert got.schema.field("s").type == pa.int64()
    assert col(got, "s") == [1, 2, None]
    assert got.schema.field("f").type == pa.string()
    assert got.schema.field("d").type == pa.timestamp("us", "UTC")
    assert col(got, "d")[1] == datetime(2026, 1, 1, 18, tzinfo=UTC)
    flags = run(
        [{"type": "cast_type", "column": "s", "to": "bool"}], base=pa.table({"s": ["TRUE", "false", "1"]})
    )
    assert col(flags, "s") == [True, False, True]


def test_cast_failure_is_a_step_error_without_data_values() -> None:
    table = pa.table({"s": ["1", "secret-value-42"]})
    with pytest.raises(S.StepError) as exc:
        run([{"type": "limit", "n": 5}, {"type": "cast_type", "column": "s", "to": "int"}], base=table)
    assert (exc.value.step_index, exc.value.reason) == (1, "CAST_FAILED")
    assert "secret" not in exc.value.message and "secret" not in str(exc.value.details())
    with pytest.raises(S.StepError) as exc:
        run([{"type": "cast_type", "column": "f", "to": "int"}], base=pa.table({"f": [1.5]}))
    assert exc.value.reason == "CAST_FAILED" and "1.5" not in exc.value.message


def test_cast_planning_rejects_impossible_conversions() -> None:
    assert invalid([{"type": "cast_type", "column": "measured_at", "to": "int"}]).reason == "TYPE_MISMATCH"
    assert invalid([{"type": "cast_type", "column": "cycles", "to": "datetime"}]).reason == "TYPE_MISMATCH"
    schema = plan([{"type": "cast_type", "column": "cycles", "to": "string"}])
    assert schema.field("cycles").type == pa.string()


def test_convert_unit() -> None:
    got = run(
        [
            {
                "type": "convert_unit",
                "column": "temperature_c",
                "factor": 1.8,
                "offset": 32,
                "unit_label": "degF",
            }
        ]
    )
    assert col(got, "temperature_c")[:2] == pytest.approx([77.0, 113.0])
    assert col(got, "temperature_c")[3] is None
    assert got.schema.field("temperature_c").metadata == {b"unit": b"degF"}
    ints = run([{"type": "convert_unit", "column": "cycles", "factor": 2, "offset": 0, "unit_label": "x2"}])
    assert ints.schema.field("cycles").type == pa.float64() and col(ints, "cycles")[0] == 2.0
    assert (
        invalid(
            [{"type": "convert_unit", "column": "note", "factor": 1, "offset": 0, "unit_label": "u"}]
        ).reason
        == "TYPE_MISMATCH"
    )


# ---------------------------------------------------------------- aggregate


def test_aggregate_by_group() -> None:
    got = run(
        [
            {"type": "drop_missing", "columns": ["cell_id"]},
            {
                "type": "aggregate",
                "group_by": ["cell_id"],
                "metrics": [
                    {"column": "temperature_c", "fn": "mean"},
                    {"column": "cycles", "fn": "sum"},
                    {"column": "cycles", "fn": "count"},
                    {"column": "note", "fn": "max"},
                    {"column": "temperature_c", "fn": "min"},
                ],
            },
            {"type": "sort", "by": ["cell_id"], "descending": False},
        ]
    )
    assert got.column_names == [
        "cell_id",
        "temperature_c_mean",
        "cycles_sum",
        "cycles_count",
        "note_max",
        "temperature_c_min",
    ]
    assert col(got, "cell_id") == ["C-01", "C-02", "C-03"]
    assert col(got, "temperature_c_mean") == [35.0, 50.0, None]
    assert col(got, "cycles_sum") == [3, 3, 4]
    assert col(got, "cycles_count") == [2, 1, 1]
    assert col(got, "note_max") == ["hot", None, "cold start"]


def test_aggregate_without_groups_gives_one_row() -> None:
    got = run([{"type": "aggregate", "group_by": [], "metrics": [{"column": "cycles", "fn": "sum"}]}])
    assert got.to_pylist() == [{"cycles_sum": 15}]


def test_aggregate_planning() -> None:
    schema = plan(
        [{"type": "aggregate", "group_by": ["cell_id"], "metrics": [{"column": "cycles", "fn": "mean"}]}]
    )
    assert [(f.name, f.type) for f in schema] == [("cell_id", pa.string()), ("cycles_mean", pa.float64())]
    assert (
        invalid([{"type": "aggregate", "group_by": [], "metrics": [{"column": "note", "fn": "sum"}]}]).reason
        == "TYPE_MISMATCH"
    )
    assert (
        invalid(
            [{"type": "aggregate", "group_by": ["nope"], "metrics": [{"column": "cycles", "fn": "sum"}]}]
        ).reason
        == "UNKNOWN_COLUMN"
    )
    dup = [
        {
            "type": "aggregate",
            "group_by": [],
            "metrics": [{"column": "cycles", "fn": "sum"}, {"column": "cycles", "fn": "sum"}],
        }
    ]
    assert invalid(dup).reason == "DUPLICATE_COLUMN"
    # later steps see the aggregated columns only
    later = [
        {"type": "aggregate", "group_by": ["cell_id"], "metrics": [{"column": "cycles", "fn": "sum"}]},
        {"type": "filter_rows", "column": "cycles", "op": "gt", "value": 1},
    ]
    error = invalid(later)
    assert (error.step_index, error.reason, error.column) == (1, "UNKNOWN_COLUMN", "cycles")


# ---------------------------------------------------------------- join


def test_inner_and_left_join() -> None:
    inner = run(
        [
            {"type": "join", "right_input_id": str(RIGHT), "on": ["cell_id"], "how": "inner"},
            {"type": "sort", "by": ["cycles", "chemistry"], "descending": False},
        ]
    )
    assert col(inner, "cycles") == [1, 2, 3, 3]
    assert col(inner, "chemistry") == ["NMC", "NMC", "LFP", "LFP-b"]
    left = run(
        [
            {"type": "join", "right_input_id": str(RIGHT), "on": ["cell_id"], "how": "left"},
            {"type": "sort", "by": ["cycles", "chemistry"], "descending": False},
        ]
    )
    assert col(left, "cycles") == [1, 2, 3, 3, 4, 5]
    assert col(left, "chemistry")[-2:] == [None, None]


def test_join_suffixes_colliding_columns() -> None:
    right = pa.table({"cell_id": ["C-01"], "note": ["spec note"]})
    got = run(
        [{"type": "join", "right_input_id": str(RIGHT), "on": ["cell_id"], "how": "inner"}], right=right
    )
    assert "note" in got.column_names and "note_right" in got.column_names


def test_join_planning_errors() -> None:
    error = invalid([{"type": "join", "right_input_id": str(OTHER), "on": ["cell_id"], "how": "inner"}])
    assert (error.reason, error.input_id) == ("UNKNOWN_INPUT", OTHER)
    error = invalid([{"type": "join", "right_input_id": str(RIGHT), "on": ["chemistry"], "how": "inner"}])
    assert (error.reason, error.column) == ("UNKNOWN_COLUMN", "chemistry")
    numeric_key = pa.table({"cell_id": [1, 2], "x": [1, 2]})
    with pytest.raises(S.StepError) as exc:
        S.plan(
            parse_steps([{"type": "join", "right_input_id": str(RIGHT), "on": ["cell_id"], "how": "inner"}]),
            {BASE: cells().schema, RIGHT: numeric_key.schema},
            IDS,
        )
    assert exc.value.reason == "TYPE_MISMATCH"


def test_join_that_would_exceed_the_row_limit_fails_before_joining() -> None:
    left = pa.table({"k": [1] * 50})
    right = pa.table({"k": [1] * 50, "v": list(range(50))})
    step = [{"type": "join", "right_input_id": str(RIGHT), "on": ["k"], "how": "inner"}]
    with pytest.raises(S.StepError) as exc:
        run(step, base=left, right=right, max_rows=2_000)
    assert exc.value.reason == "TOO_MANY_ROWS"
    assert run(step, base=left, right=right, max_rows=2_500).num_rows == 2_500


def test_needed_inputs_are_the_base_and_joined_inputs() -> None:
    joined = parse_steps([{"type": "join", "right_input_id": str(RIGHT), "on": ["k"], "how": "inner"}])
    assert S.needed_inputs(joined, [BASE, RIGHT, OTHER]) == [BASE, RIGHT]
    assert S.needed_inputs([], [BASE, RIGHT]) == [BASE]


def test_check_is_called_between_steps() -> None:
    calls: list[int] = []
    run([{"type": "limit", "n": 3}, {"type": "limit", "n": 2}], check=lambda: calls.append(1))
    assert len(calls) >= 2


def test_preview_cells_are_strings_cut_to_200_chars() -> None:
    table = pa.table(
        {
            "a": [1, None],
            "b": [2875.4, 1.0],
            "c": [True, False],
            "d": pa.array([datetime(2026, 1, 1, tzinfo=UTC), None], pa.timestamp("us", "UTC")),
            "e": ["x" * 300, "y"],
        }
    )
    rows = S.preview_rows(table, 100)
    assert rows[0][:4] == ["1", "2875.4", "true", "2026-01-01T00:00:00+00:00"]
    assert len(rows[0][4]) == 200
    assert rows[1][0] is None and rows[1][3] is None


# ---------------------------------------------------------------- review fixes: NaN, joins, integer bounds


def test_nan_never_matches_ne_and_is_not_counted() -> None:
    table = pa.table({"g": ["a", "a", "a", "a"], "x": [1.0, float("nan"), None, 2.0]})
    assert col(run([{"type": "filter_rows", "column": "x", "op": "ne", "value": 1}], base=table), "x") == [
        2.0
    ]
    assert col(run([{"type": "filter_rows", "column": "x", "op": "in", "value": [2]}], base=table), "x") == [
        2.0
    ]
    got = run(
        [
            {
                "type": "aggregate",
                "group_by": ["g"],
                "metrics": [
                    {"column": "x", "fn": "count"},
                    {"column": "x", "fn": "mean"},
                    {"column": "x", "fn": "max"},
                ],
            }
        ],
        base=table,
    )
    assert got.to_pylist() == [{"g": "a", "x_count": 2, "x_mean": 1.5, "x_max": 2.0}]


def test_cast_float_to_int_treats_nan_as_missing() -> None:
    got = run([{"type": "cast_type", "column": "x", "to": "int"}], base=pa.table({"x": [1.0, float("nan")]}))
    assert col(got, "x") == [1, None]


def test_join_names_agree_between_plan_and_execution() -> None:
    left = pa.table({"k": [1], "a": ["left"]})
    right = pa.table({"k": [1], "a": ["right"], "a_right": ["right2"]})
    step = parse_steps([{"type": "join", "right_input_id": str(RIGHT), "on": ["k"], "how": "inner"}])
    planned = S.plan(step, {BASE: left.schema, RIGHT: right.schema}, IDS)
    got = S.apply(step, {BASE: left, RIGHT: right}, IDS, max_rows=10)
    assert got.column_names == planned.names == ["k", "a", "a_right", "a_right_right"]
    assert got.to_pylist() == [{"k": 1, "a": "left", "a_right": "right", "a_right_right": "right2"}]
    clash = pa.table({"k": [1], "a": ["l"], "a_right": ["l2"]})
    with pytest.raises(S.StepError) as exc:
        S.plan(step, {BASE: clash.schema, RIGHT: pa.table({"k": [1], "a": ["r"]}).schema}, IDS)
    assert exc.value.reason == "DUPLICATE_COLUMN"


def test_join_keys_take_the_wider_type() -> None:
    left = pa.table({"k": pa.array([1, 2], pa.int32())})
    big = 2**40
    right = pa.table({"k": pa.array([1, big], pa.int64()), "v": ["one", "big"]})
    step = parse_steps([{"type": "join", "right_input_id": str(RIGHT), "on": ["k"], "how": "left"}])
    planned = S.plan(step, {BASE: left.schema, RIGHT: right.schema}, IDS)
    got = S.apply(step, {BASE: left, RIGHT: right}, IDS, max_rows=10)
    assert planned.field("k").type == got.schema.field("k").type == pa.int64()
    assert got.sort_by("k").to_pylist() == [{"k": 1, "v": "one"}, {"k": 2, "v": None}]


def test_integer_literals_are_bounded_to_int64() -> None:
    for value in (2**63, -(2**63) - 1):
        with pytest.raises(ValidationError):
            parse_steps([{"type": "filter_rows", "column": "cycles", "op": "eq", "value": value}])
        with pytest.raises(ValidationError):
            parse_steps([{"type": "fill_missing", "column": "cycles", "value": value}])
    assert col(
        run([{"type": "filter_rows", "column": "cycles", "op": "lt", "value": 2**63 - 1}]), "cycles"
    ) == [
        1,
        2,
        3,
        4,
        5,
    ]


def test_integer_sum_overflow_is_a_clear_step_error() -> None:
    table = pa.table({"g": ["a", "a"], "v": pa.array([2**62, 2**62], pa.int64())})
    with pytest.raises(S.StepError) as exc:
        run([{"type": "aggregate", "group_by": ["g"], "metrics": [{"column": "v", "fn": "sum"}]}], base=table)
    assert exc.value.reason == "STEP_FAILED" and "integer range" in exc.value.message
    ok = pa.table({"g": ["a", "a"], "v": pa.array([2**61, 2**61], pa.int64())})
    got = run([{"type": "aggregate", "group_by": ["g"], "metrics": [{"column": "v", "fn": "sum"}]}], base=ok)
    assert col(got, "v_sum") == [2**62]
