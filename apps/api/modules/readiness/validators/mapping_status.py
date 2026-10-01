"""semantics.mapping_status (09 §3.9). P0 source: x-nais-concept in _schema.json only."""

import re
from typing import Any

from api.modules.readiness.engine.canonical import ratio
from api.modules.readiness.engine.context import CheckOutcome, EvaluationContext

_IRI = re.compile(r"https?://\S+")


def check(ctx: EvaluationContext) -> CheckOutcome:
    doc = ctx.schema_doc
    if not ctx.tabular or not doc.valid:
        message = "표 형식 파일 또는 유효한 _schema.json이 없어 평가하지 않습니다."
        return CheckOutcome("NOT_APPLICABLE", message, {"declared_fields": 0})
    declared = mapped = 0
    unmapped: list[dict[str, str]] = []
    malformed: list[dict[str, str]] = []
    for path in sorted(doc.resources):
        for fld in doc.resources[path].fields:
            declared += 1
            if fld.concept is not None and _IRI.fullmatch(fld.concept):
                mapped += 1
                continue
            unmapped.append({"path": path, "field": fld.name})
            if fld.concept is not None:
                malformed.append({"path": path, "field": fld.name})
    share = ratio(mapped, declared)
    evidence: dict[str, Any] = {
        "declared_fields": declared,
        "mapped_fields": mapped,
        "ratio": share,
        "unmapped": sorted(unmapped, key=lambda e: (e["path"], e["field"])),
        "malformed_iri": sorted(malformed, key=lambda e: (e["path"], e["field"])),
    }
    if share >= ctx.params.mapping_pass_ratio:
        return CheckOutcome(
            "PASS", f"필드 {declared}개 중 {mapped}개가 개념 IRI에 매핑되어 있습니다.", evidence
        )
    threshold = f"{ctx.params.mapping_pass_ratio:.0%}"
    return CheckOutcome(
        "WARNING", f"개념 IRI 매핑 비율이 {threshold} 미만입니다 ({mapped}/{declared}).", evidence
    )
