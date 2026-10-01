"""provenance.presence (09 §3.6)."""

import re

from api.modules.readiness.engine.context import CheckOutcome, EvaluationContext

_HEADING = re.compile(r"^(#{1,6})[ \t]+(.*?)[ \t#]*$")
_PROVENANCE_TITLE = re.compile(r"^(provenance|출처|데이터 출처|생성 방법)$", re.IGNORECASE)


def readme_provenance_section(text: str) -> str | None:
    """Trimmed body of the first #..### heading named like provenance, up to the next heading; None if absent."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        match = _HEADING.match(line)
        if match and len(match.group(1)) <= 3 and _PROVENANCE_TITLE.match(match.group(2).strip()):
            body: list[str] = []
            for following in lines[i + 1 :]:
                if _HEADING.match(following):
                    break
                body.append(following)
            return "\n".join(body).strip()
    return None


def check(ctx: EvaluationContext) -> CheckOutcome:
    raw = ctx.snapshot.get("provenance")
    metadata_length = len(raw.strip()) if isinstance(raw, str) else 0
    section = readme_provenance_section(ctx.readme_text) if ctx.readme_text is not None else None
    section_length = len(section) if section is not None else 0
    evidence = {
        "metadata_provenance_length": metadata_length,
        "readme_present": ctx.readme_present,
        "readme_section_found": section is not None,
        "readme_section_length": section_length,
    }
    minimum = ctx.params.provenance_min_length
    if max(metadata_length, section_length) >= minimum:
        return CheckOutcome("PASS", "데이터 출처(provenance)가 기록되어 있습니다.", evidence)
    if metadata_length or section_length:
        return CheckOutcome("WARNING", f"데이터 출처 설명이 {minimum}자 미만으로 짧습니다.", evidence)
    message = "데이터 출처(provenance)가 없습니다. 메타데이터 provenance 또는 README.md의 Provenance 섹션을 작성하세요."
    return CheckOutcome("FAIL", message, evidence)
