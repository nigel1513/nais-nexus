"""metadata.completeness (09 §3.1)."""

from typing import Any

from api.modules.readiness.engine.context import CheckOutcome, EvaluationContext


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def check(ctx: EvaluationContext) -> CheckOutcome:
    snap = ctx.snapshot
    p = ctx.params
    raw_keywords = snap.get("keywords")
    keywords = raw_keywords if isinstance(raw_keywords, list) else []
    keyword_count = len([k for k in keywords if _text(k)])
    description_length = len(_text(snap.get("description")))
    required_missing = sorted(
        name
        for name, ok in (
            ("title", len(_text(snap.get("title"))) >= 3),
            ("description", description_length >= p.description_min_length),
            ("license", bool(_text(snap.get("license")))),
            ("contact_email", bool(_text(snap.get("contact_email")))),
            ("keywords", keyword_count >= 1),
        )
        if not ok
    )
    recommended_missing = sorted(
        name
        for name, ok in (
            ("keywords_min_3", keyword_count >= 3),
            ("domain", bool(_text(snap.get("domain")))),
            ("readme", ctx.readme_present),
        )
        if not ok
    )
    evidence = {
        "required_missing": required_missing,
        "recommended_missing": recommended_missing,
        "description_length": description_length,
        "keyword_count": keyword_count,
        "readme_present": ctx.readme_present,
    }
    if required_missing:
        labels = [
            f"description({p.description_min_length}자 미만)" if n == "description" else n
            for n in required_missing
        ]
        message = f"필수 메타데이터 {len(required_missing)}개가 누락되었습니다: {', '.join(labels)}."
        return CheckOutcome("FAIL", message, evidence)
    if recommended_missing:
        return CheckOutcome(
            "WARNING", f"권장 메타데이터가 부족합니다: {', '.join(recommended_missing)}.", evidence
        )
    return CheckOutcome("PASS", "필수·권장 메타데이터가 모두 채워져 있습니다.", evidence)
