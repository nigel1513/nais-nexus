"""data.missing_values (09 §3.4)."""

from fractions import Fraction
from typing import Any

from api.modules.readiness.engine.canonical import exceeds, fraction, ratio
from api.modules.readiness.engine.context import CheckOutcome, EvaluationContext


def check(ctx: EvaluationContext) -> CheckOutcome:
    if not ctx.tabular:
        return CheckOutcome("NOT_APPLICABLE", "표 형식 데이터 파일이 없어 평가하지 않습니다.", {"fields": []})
    p = ctx.params
    fields: list[dict[str, Any]] = []
    violations: list[dict[str, Any]] = []
    total_cells = total_missing = 0
    worst = Fraction(0)
    for ref in ctx.tabular:
        stats = ctx.file_stats(ref.path)
        resource = ctx.resource(ref.path)
        must_have: set[str] = set()
        if resource is not None:
            must_have = set(resource.primary_key) | {f.name for f in resource.fields if f.required}
        for name in sorted(stats.columns):
            col = stats.columns[name]
            total_cells += stats.sampled_rows
            total_missing += col.missing
            if col.missing == 0:
                continue
            field_ratio = ratio(col.missing, stats.sampled_rows)
            worst = max(worst, fraction(col.missing, stats.sampled_rows))
            fields.append({"path": ref.path, "field": name, "missing": col.missing, "ratio": field_ratio})
            if name in must_have:
                violations.append({"path": ref.path, "field": name, "missing": col.missing})
    overall = ratio(total_missing, total_cells)
    overall_exact = fraction(total_missing, total_cells)
    evidence: dict[str, Any] = {
        "overall_missing_ratio": overall,
        "fields": fields,
        "required_field_violations": violations,
    }
    if ctx.skipped_tabular:
        evidence["skipped_files"] = ctx.skipped_tabular
    if violations or exceeds(worst, p.missing_fail_ratio):
        message = "필수 필드(primaryKey/required)에 결측이 있거나 결측률 50%를 넘는 필드가 있습니다."
        return CheckOutcome("FAIL", message, evidence)
    if exceeds(worst, p.missing_warn_ratio) or exceeds(overall_exact, p.missing_overall_warn_ratio):
        return CheckOutcome(
            "WARNING", "결측률이 5%를 넘는 필드가 있거나 전체 결측률이 5%를 넘습니다.", evidence
        )
    return CheckOutcome("PASS", f"결측률이 허용 범위 이내입니다 (전체 {overall:.2%}).", evidence)
