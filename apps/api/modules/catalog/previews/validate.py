"""Re-validation of the child's outcome in the parent (Task 11 review 1): the child processes hostile bytes, so its
output is untrusted. The shapes mirror contract 1.3.0 FileProfile / FilePreview with every bound the profiler
promises (cells and names <= cell_chars, <= 100 rows, <= 20 bins, <= 10 top values, both JSON documents within
their byte ceilings, no raw values in the profile). Anything else is rejected (GENERATION_FAILED)."""

import json
from functools import lru_cache
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError, model_validator

from api.modules.catalog.previews.profile import (
    MAX_HISTOGRAM_BINS,
    MAX_IRI_CHARS,
    MAX_TOP_VALUES,
    MAX_TOTAL_ROWS,
    PreviewLimits,
)

_STRICT = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class InvalidOutcome(Exception):
    """The child's outcome does not have the shape and bounds the profiler guarantees."""


@lru_cache(maxsize=8)
def _models(limits: PreviewLimits) -> type[BaseModel]:
    Cell = Annotated[str, StringConstraints(max_length=limits.cell_chars)]
    Count = Annotated[int, Field(ge=0)]
    Number = float | int

    class ColumnProfile(BaseModel):
        model_config = _STRICT
        name: Cell
        type: Literal["string", "integer", "number", "boolean", "date", "datetime"]
        unit: Cell | None
        description: Cell | None
        concept_iri: Annotated[str, StringConstraints(max_length=MAX_IRI_CHARS)] | None
        missing_ratio: Annotated[Number, Field(ge=0, le=1)]
        distinct_count: Annotated[int, Field(ge=0, le=limits.distinct_cap)]
        distinct_capped: bool

    class Bin(BaseModel):
        model_config = _STRICT
        lower: Number
        upper: Number
        count: Count

    class TopValue(BaseModel):
        model_config = _STRICT
        value: Cell
        count: Count

    class Distribution(BaseModel):
        model_config = _STRICT
        name: Cell
        kind: Literal["numeric", "categorical", "other"]
        min: Number | None = None
        max: Number | None = None
        mean: Number | None = None
        histogram: Annotated[list[Bin], Field(max_length=MAX_HISTOGRAM_BINS)] = []
        top_values: Annotated[list[TopValue], Field(max_length=MAX_TOP_VALUES)] = []

    class Preview(BaseModel):
        model_config = _STRICT
        header: Annotated[list[Cell], Field(max_length=limits.max_columns)]
        rows: Annotated[
            list[Annotated[list[Cell | None], Field(max_length=limits.max_columns)]],
            Field(max_length=limits.preview_rows),
        ]
        rows_truncated: bool
        columns: Annotated[list[Distribution], Field(max_length=limits.max_columns)]

    class Result(BaseModel):
        model_config = _STRICT
        format: Literal["csv", "tsv", "parquet"]
        rows_sampled: Annotated[int, Field(ge=0, le=limits.max_rows)]
        total_rows: Annotated[int, Field(ge=0, le=MAX_TOTAL_ROWS)] | None = None
        truncated: bool
        columns_truncated: bool
        column_profile: Annotated[list[ColumnProfile], Field(max_length=limits.max_columns)]
        preview: Preview

        @model_validator(mode="after")
        def _total_covers_sample(self) -> "Result":
            if self.total_rows is not None and self.total_rows < self.rows_sampled:
                raise ValueError("total_rows is below rows_sampled")
            return self

    return Result


def _scrub(value: Any) -> Any:
    """JSONB cannot store U+0000: every string (cells, header and column names, top values) gets U+FFFD instead."""
    if isinstance(value, str):
        return value.replace("\x00", "\ufffd")
    if isinstance(value, list):
        return [_scrub(v) for v in value]
    if isinstance(value, dict):
        return {k: _scrub(v) for k, v in value.items()}
    return value


def validate_result(result: Any, limits: PreviewLimits) -> dict[str, Any]:
    """The child's "result" object, checked; raises InvalidOutcome."""
    try:
        _models(limits).model_validate(result)
    except ValidationError as exc:
        raise InvalidOutcome(str(exc)[:500]) from None
    profile_size = len(
        json.dumps(result["column_profile"], ensure_ascii=False).encode("utf-8", "surrogatepass")
    )
    if profile_size > limits.profile_bytes:
        raise InvalidOutcome(f"column profile of {profile_size} bytes")
    preview_size = len(json.dumps(result["preview"]))
    if preview_size > limits.preview_bytes:
        raise InvalidOutcome(f"preview of {preview_size} bytes")
    scrubbed: dict[str, Any] = _scrub(result)
    return scrubbed
