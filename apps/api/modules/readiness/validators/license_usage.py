"""policy.license_usage (09 §3.7)."""

import re
from functools import lru_cache
from pathlib import Path

from api.modules.readiness.engine.context import CheckOutcome, EvaluationContext

_NAIS_LICENSE = re.compile(r"NAIS-[A-Z0-9-]+-[0-9]+\.[0-9]+")
_SPDX_FILE = Path(__file__).resolve().parents[1] / "dictionaries" / "spdx_license_ids_v1.txt"


@lru_cache(maxsize=1)
def spdx_ids() -> frozenset[str]:
    lines = _SPDX_FILE.read_text(encoding="utf-8").splitlines()
    return frozenset(line.strip() for line in lines if line.strip() and not line.startswith("#"))


def license_recognized(license_id: str) -> bool:
    return license_id in spdx_ids() or _NAIS_LICENSE.fullmatch(license_id) is not None


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def check(ctx: EvaluationContext) -> CheckOutcome:
    snap = ctx.snapshot
    license_id = _text(snap.get("license"))
    usage = _text(snap.get("usage_policy"))
    access_level = snap.get("access_level")
    raw_purposes = snap.get("allowed_purposes")
    purposes = raw_purposes if isinstance(raw_purposes, list) else []
    recognized = bool(license_id) and license_recognized(license_id)
    evidence = {
        "license": license_id,
        "license_recognized": recognized,
        "access_level": access_level,
        "usage_policy_length": len(usage),
        "allowed_purposes_count": len(purposes),
    }
    minimum = ctx.params.usage_policy_min_length
    usage_ok = access_level in ("PUBLIC", "INTERNAL") or len(usage) >= minimum
    if not license_id:
        return CheckOutcome("FAIL", "라이선스가 지정되지 않았습니다.", evidence)
    if not usage_ok:
        message = f"{access_level} 데이터에는 {minimum}자 이상의 이용 정책(usage_policy)이 필요합니다."
        return CheckOutcome("FAIL", message, evidence)
    if not recognized:
        return CheckOutcome(
            "WARNING", "라이선스 식별자를 SPDX 또는 NAIS 라이선스로 인식할 수 없습니다.", evidence
        )
    return CheckOutcome("PASS", "라이선스와 이용 정책이 확인되었습니다.", evidence)
