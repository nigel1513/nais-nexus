"""schema.presence (09 §3.2)."""

from typing import Any

from api.modules.readiness.engine.context import CheckOutcome, EvaluationContext


def check(ctx: EvaluationContext) -> CheckOutcome:
    tabular_paths = [f.path for f in ctx.tabular]
    if not tabular_paths:
        return CheckOutcome(
            "NOT_APPLICABLE", "표 형식 데이터 파일이 없어 평가하지 않습니다.", {"tabular_files": 0}
        )
    doc = ctx.schema_doc
    evidence: dict[str, Any] = {
        "tabular_files": len(tabular_paths),
        "described": 0,
        "undescribed": [],
        "schema_present": doc.present,
        "schema_errors": list(doc.errors),
        "unknown_resource_paths": [],
        "header_mismatch": [],
    }
    if ctx.skipped_tabular:
        evidence["skipped_files"] = ctx.skipped_tabular
    if not doc.present:
        evidence["undescribed"] = tabular_paths
        if all(p.lower().endswith(".parquet") for p in tabular_paths):
            return CheckOutcome("WARNING", "_schema.json이 없어 parquet 내장 스키마로 대체합니다.", evidence)
        return CheckOutcome(
            "FAIL", "_schema.json이 없습니다. 표 형식 파일의 필드와 타입을 기술하세요.", evidence
        )
    if not doc.valid:
        return CheckOutcome("FAIL", "_schema.json을 해석할 수 없거나 스키마 규칙을 위반합니다.", evidence)

    evidence["unknown_resource_paths"] = sorted(p for p in doc.resources if p not in ctx.by_path)
    fail = bool(evidence["unknown_resource_paths"])
    warn = False
    for path in tabular_paths:
        resource = doc.resources.get(path)
        if resource is None:
            evidence["undescribed"].append(path)
            if path.lower().endswith(".parquet"):
                warn = True
            else:
                fail = True
            continue
        evidence["described"] += 1
        stats = ctx.file_stats(path)
        declared = {f.name for f in resource.fields}
        missing_in_header = sorted(declared - set(stats.header))
        undeclared = sorted(set(stats.header) - declared)
        duplicates = stats.duplicate_columns
        if missing_in_header or undeclared or duplicates:
            entry: dict[str, Any] = {
                "path": path,
                "missing_in_header": missing_in_header,
                "undeclared_columns": undeclared,
            }
            if duplicates:
                entry["duplicate_columns"] = duplicates
            evidence["header_mismatch"].append(entry)
            fail = fail or bool(missing_in_header or duplicates)
            warn = warn or bool(undeclared)
    if fail:
        return CheckOutcome(
            "FAIL", "스키마에 기술되지 않은 파일이 있거나 선언된 필드가 헤더와 맞지 않습니다.", evidence
        )
    if warn:
        return CheckOutcome(
            "WARNING", "일부 컬럼 또는 parquet 파일이 스키마에 기술되지 않았습니다.", evidence
        )
    return CheckOutcome("PASS", f"표 형식 파일 {len(tabular_paths)}개가 모두 스키마와 일치합니다.", evidence)
