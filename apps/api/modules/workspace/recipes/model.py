"""Recipe step request models (openapi RecipeStep oneOf, discriminator `type`).

They mirror the contract schemas and add what the generated models cannot express: strict JSON scalar types
(a boolean is never an integer), no NUL characters in column names, finite numbers, distinct column lists.
Pure: no I/O, used by the service (request bodies, stored JSON) and by recipes.steps.
"""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictFloat,
    StrictInt,
    StrictStr,
    StringConstraints,
    TypeAdapter,
)


def _no_nul(value: str) -> str:
    if "\x00" in value:
        raise ValueError("must not contain NUL characters")
    return value


def _distinct(values: list[str]) -> list[str]:
    if len(set(values)) != len(values):
        raise ValueError("column names must be distinct")
    return values


ColumnName = Annotated[str, StringConstraints(min_length=1, max_length=255), AfterValidator(_no_nul)]
Columns = Annotated[list[ColumnName], Field(min_length=1, max_length=1000), AfterValidator(_distinct)]
Text = Annotated[StrictStr, StringConstraints(max_length=1000), AfterValidator(_no_nul)]
Number = StrictInt | Annotated[StrictFloat, Field(allow_inf_nan=False)]
Scalar = Text | Number | StrictBool
FilterValue = Scalar | Annotated[list[Text | Number], Field(max_length=1000)] | None


class _Step(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class SelectColumns(_Step):
    type: Literal["select_columns"]
    columns: Columns


FilterOp = Literal["eq", "ne", "lt", "le", "gt", "ge", "contains", "in", "is_null", "not_null"]


class FilterRows(_Step):
    type: Literal["filter_rows"]
    column: ColumnName
    op: FilterOp
    value: FilterValue = None


class DropMissing(_Step):
    type: Literal["drop_missing"]
    # None: a missing value in any column drops the row; [] drops nothing
    columns: Annotated[list[ColumnName], Field(max_length=1000), AfterValidator(_distinct)] | None


class FillMissing(_Step):
    type: Literal["fill_missing"]
    column: ColumnName
    value: Scalar


CastTo = Literal["int", "float", "string", "bool", "datetime"]


class CastType(_Step):
    type: Literal["cast_type"]
    column: ColumnName
    to: CastTo


class ConvertUnit(_Step):
    type: Literal["convert_unit"]
    column: ColumnName
    factor: Annotated[StrictFloat | StrictInt, Field(allow_inf_nan=False)]
    offset: Annotated[StrictFloat | StrictInt, Field(allow_inf_nan=False)]
    unit_label: Annotated[str, StringConstraints(min_length=1, max_length=32), AfterValidator(_no_nul)]


AggregateFn = Literal["count", "sum", "mean", "min", "max"]


class Metric(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    column: ColumnName
    fn: AggregateFn


class Aggregate(_Step):
    type: Literal["aggregate"]
    group_by: Annotated[list[ColumnName], Field(max_length=100), AfterValidator(_distinct)]
    metrics: Annotated[list[Metric], Field(min_length=1, max_length=100)]


class Join(_Step):
    type: Literal["join"]
    right_input_id: UUID
    on: Columns
    how: Literal["inner", "left"]


class Sort(_Step):
    type: Literal["sort"]
    by: Columns
    descending: StrictBool


class Limit(_Step):
    type: Literal["limit"]
    n: Annotated[StrictInt, Field(ge=1, le=5_000_000)]


Step = Annotated[
    SelectColumns
    | FilterRows
    | DropMissing
    | FillMissing
    | CastType
    | ConvertUnit
    | Aggregate
    | Join
    | Sort
    | Limit,
    Field(discriminator="type"),
]
StepList = Annotated[list[Step], Field(max_length=50)]

_STEPS: TypeAdapter[list[Step]] = TypeAdapter(StepList)


def parse_steps(data: object) -> list[Step]:
    """Stored/API JSON -> steps (pydantic ValidationError on a shape the contract does not allow)."""
    return _STEPS.validate_python(data)


def dump_steps(steps: list[Step]) -> list[dict[str, object]]:
    """Steps -> JSON-ready dicts in the contract shape (filter `value` is kept even when null)."""
    return [s.model_dump(mode="json") for s in steps]
