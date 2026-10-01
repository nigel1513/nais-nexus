"""semantics.units_codebook (09 §3.5). Unit strings are schema metadata, so evidence may show them."""

from typing import Any

from api.modules.readiness.engine.canonical import ratio
from api.modules.readiness.engine.context import CheckOutcome, EvaluationContext
from api.modules.readiness.engine.units import suggestion, unit_error

NUMERIC_TYPES = ("integer", "number")


def numeric_fields(ctx: EvaluationContext) -> list[tuple[str, str]]:
    """(path, field) of every numeric field in T: declared integer/number, or a numeric undescribed parquet column."""
    found: set[tuple[str, str]] = set()
    for ref in ctx.tabular:
        resource = ctx.resource(ref.path)
        if resource is not None:
            found |= {(ref.path, f.name) for f in resource.fields if f.type in NUMERIC_TYPES}
        elif ref.path.lower().endswith(".parquet"):
            found |= {(ref.path, name) for name in ctx.file_stats(ref.path).parquet_numeric}
    return sorted(found)


def check(ctx: EvaluationContext) -> CheckOutcome:
    fields = numeric_fields(ctx)
    if not fields:
        return CheckOutcome(
            "NOT_APPLICABLE", "숫자형 필드가 없어 단위를 평가하지 않습니다.", {"numeric_fields": 0}
        )
    schema_units = {
        (path, f.name): f.unit
        for path, resource in ctx.schema_doc.resources.items()
        for f in resource.fields
        if f.unit is not None
    }
    codebook_units = ctx.codebook.units
    missing: list[dict[str, str]] = []
    invalid: list[dict[str, str]] = []
    conflicts: list[dict[str, str]] = []
    with_valid = 0
    for key in fields:
        path, name = key
        schema_unit, codebook_unit = schema_units.get(key), codebook_units.get(key)
        if schema_unit is not None and codebook_unit is not None and schema_unit != codebook_unit:
            conflicts.append(
                {"path": path, "field": name, "schema_unit": schema_unit, "codebook_unit": codebook_unit}
            )
        units = [u for u in (schema_unit, codebook_unit) if u is not None]
        if not units:
            missing.append({"path": path, "field": name})
            continue
        bad = [(u, e) for u in dict.fromkeys(units) if (e := unit_error(u)) is not None]
        invalid.extend({"path": path, "field": name, "unit": u, "error": e} for u, e in bad)
        with_valid += not bad
    undefined: list[dict[str, Any]] = []
    for ref in ctx.tabular:
        coded = sorted(f for (p, f) in ctx.codebook.codes if p == ref.path)
        if not coded:
            continue
        stats = ctx.file_stats(ref.path)
        for name in coded:
            col = stats.columns.get(name)
            if col is not None and col.undefined_codes:
                undefined.append({"path": ref.path, "field": name, "undefined": col.undefined_codes})
    missing_ratio = ratio(len(missing), len(fields))
    evidence = {
        "numeric_fields": len(fields),
        "with_valid_unit": with_valid,
        "missing_unit": missing,
        "missing_unit_ratio": missing_ratio,
        "invalid_unit": invalid,
        "conflicts": conflicts,
        "undefined_code_counts": undefined,
    }
    if not ctx.schema_doc.present and not ctx.codebook.present:
        return CheckOutcome("FAIL", "단위 정보 출처(_schema.json, _codebook.csv)가 없습니다.", evidence)
    if invalid:
        first = invalid[0]
        hint = suggestion(first["unit"])
        example = f"{first['field']}: {first['unit']}" + (f" → {hint}" if hint else "")
        message = f"UCUM 단위로 해석할 수 없는 값이 {len(invalid)}개 있습니다 (예: {example})."
        return CheckOutcome("FAIL", message, evidence)
    if missing_ratio > ctx.params.unit_missing_fail_ratio:
        return CheckOutcome(
            "FAIL", f"단위가 없는 숫자형 필드가 {len(missing)}개로 허용 한도를 넘습니다.", evidence
        )
    if missing or conflicts or undefined:
        message = "단위 누락, schema/codebook 단위 충돌 또는 codebook에 없는 코드가 있습니다."
        return CheckOutcome("WARNING", message, evidence)
    return CheckOutcome("PASS", f"숫자형 필드 {len(fields)}개가 모두 유효한 UCUM 단위를 가집니다.", evidence)
