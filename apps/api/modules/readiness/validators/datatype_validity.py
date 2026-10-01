"""schema.datatype_validity (09 §3.3)."""

from typing import Any

from api.modules.readiness.engine.canonical import ratio
from api.modules.readiness.engine.context import CheckOutcome, EvaluationContext


def evaluable_paths(ctx: EvaluationContext) -> list[str]:
    """Described csv/tsv files, plus every parquet file (its column types exist even when undescribed)."""
    return [
        f.path for f in ctx.tabular if f.path.lower().endswith(".parquet") or ctx.resource(f.path) is not None
    ]


def check(ctx: EvaluationContext) -> CheckOutcome:
    paths = evaluable_paths(ctx)
    if not paths:
        message = "타입을 검사할 수 있는 표 형식 파일이 없습니다."
        return CheckOutcome("NOT_APPLICABLE", message, {"files": [], "fields": []})
    p = ctx.params
    files: list[dict[str, Any]] = []
    fields: list[dict[str, Any]] = []
    encoding_error = False
    worst_field_ratio = worst_malformed_ratio = 0.0
    for path in paths:
        stats = ctx.file_stats(path)
        encoding_error = encoding_error or stats.encoding_error
        files.append(
            {
                "path": path,
                "sampled_rows": stats.sampled_rows,
                "truncated": stats.truncated,
                "malformed_rows": stats.malformed_rows,
                "encoding_error": stats.encoding_error,
            }
        )
        worst_malformed_ratio = max(worst_malformed_ratio, ratio(stats.malformed_rows, stats.rows_read))
        resource = ctx.resource(path)
        declared = {f.name: f.type for f in resource.fields} if resource else {}
        for name in sorted(stats.columns):
            col = stats.columns[name]
            if col.invalid == 0:
                continue
            field_ratio = ratio(col.invalid, col.checked)
            worst_field_ratio = max(worst_field_ratio, field_ratio)
            entry: dict[str, Any] = {
                "path": path,
                "field": name,
                "declared_type": declared.get(name, "string"),
                "checked": col.checked,
                "invalid": col.invalid,
                "invalid_ratio": field_ratio,
                "first_invalid_rows": list(col.first_invalid_rows),
            }
            if stats.parquet_types is not None:
                entry["parquet_type"] = stats.parquet_types.get(name)
            fields.append(entry)
    evidence: dict[str, Any] = {"files": files, "fields": fields}
    if ctx.skipped_tabular:
        evidence["skipped_files"] = ctx.skipped_tabular
    if (
        encoding_error
        or worst_field_ratio > p.datatype_fail_ratio
        or worst_malformed_ratio > p.malformed_rows_fail_ratio
    ):
        message = "타입 규칙을 위반한 값, 형식이 깨진 행 또는 인코딩 오류가 허용 한도를 넘었습니다."
        return CheckOutcome("FAIL", message, evidence)
    if worst_field_ratio > p.datatype_warn_ratio or worst_malformed_ratio > 0:
        return CheckOutcome(
            "WARNING", "일부 값이 선언된 타입과 맞지 않거나 형식이 깨진 행이 있습니다.", evidence
        )
    return CheckOutcome("PASS", "sample의 모든 값이 선언된 타입과 일치합니다.", evidence)
