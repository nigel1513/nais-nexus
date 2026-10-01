"""Regenerate the M05 readiness fixtures (09_AI_READY_RULES.md §5). Deterministic: no randomness, no clock.

Run from the repo root:  uv run python tests/fixtures/readiness/generate.py
Writes <fixture>/dataset.json, <fixture>/files/**, <fixture>/expected/*.json (keeps an already recorded
result_sha256) and fixtures.lock (sha256 of every input file). Commit the output.

W1-D5: the files/** bytes are NOT built here. They come from M03's `api.modules.catalog.seed_files.fixture_files`
(the catalog seed uploads the same files), so the golden fixtures and the seeded datasets are byte-identical by
construction. fixtures.lock pins the 09 §1.2/§5-conformant bytes; if M03's generator drifts, the lock test fails.
"""

import copy
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parents[2] / "apps"))  # script run from the repo root; pytest already has `apps`

from api.modules.catalog.seed_files import fixture_files  # noqa: E402

FIXTURES = ("clean_tabular", "missing_metadata", "invalid_units", "missing_provenance")
VALIDATOR_VERSION = "1.0.0"  # must equal api.modules.readiness.engine.VALIDATOR_VERSION

CLEAN_DATASET = {
    "title": "고분자 전해질 막 온도-압력 측정",
    "description": (
        "연료전지용 고분자 전해질 막 시편 1,000개에 대해 온도와 압력을 측정한 표 형식 데이터셋이다. "
        "재료 코드는 codebook에 정의되어 있다."
    ),
    "keywords": ["fuel-cell", "membrane", "temperature", "pressure"],
    "domain": "materials",
    "access_level": "CONTROLLED",
    "license": "CC-BY-4.0",
    "usage_policy": "학술 연구 및 AI 학습 목적에 한해 사용한다. 재배포 금지. 결과 공개 시 출처를 표기한다.",
    "allowed_purposes": ["ACADEMIC_RESEARCH", "AI_TRAINING"],
    "max_grant_days": 180,
    "contact_email": "steward@inst-b.example",
    "provenance": (
        "Institute B 연료전지 실험실의 환경 챔버(모델 EC-200)에서 2026년 1월 1일 1분 간격으로 "
        "자동 수집한 측정값."
    ),
}


def fixture_inputs(name: str) -> tuple[dict[str, object], dict[str, bytes]]:
    dataset: dict[str, object] = copy.deepcopy(CLEAN_DATASET)
    if name == "missing_metadata":
        dataset.update(description="측정 데이터", keywords=[], domain=None, contact_email=None)
    elif name == "missing_provenance":
        dataset["provenance"] = None
    return dataset, fixture_files(name)


# 09_AI_READY_RULES.md §5.6 (GENERIC_BASIC has no datatype_validity / missing_values).
GOLDEN: dict[str, dict[str, str]] = {
    "clean_tabular": {},
    "missing_metadata": {"metadata.completeness": "FAIL"},
    "invalid_units": {"semantics.units_codebook": "FAIL"},
    "missing_provenance": {"provenance.presence": "FAIL"},
}
OVERALL = {
    "clean_tabular": {"GENERIC_BASIC": "PASS", "TABULAR_ML_BASIC": "PASS"},
    "missing_metadata": {"GENERIC_BASIC": "FAIL", "TABULAR_ML_BASIC": "FAIL"},
    "invalid_units": {"GENERIC_BASIC": "WARNING", "TABULAR_ML_BASIC": "FAIL"},
    "missing_provenance": {"GENERIC_BASIC": "FAIL", "TABULAR_ML_BASIC": "FAIL"},
}
PROFILE_CHECKS = {
    "GENERIC_BASIC": [
        "metadata.completeness",
        "provenance.presence",
        "policy.license_usage",
        "integrity.file_checksum",
        "schema.presence",
        "semantics.units_codebook",
        "semantics.mapping_status",
    ],
    "TABULAR_ML_BASIC": [
        "metadata.completeness",
        "provenance.presence",
        "policy.license_usage",
        "integrity.file_checksum",
        "schema.presence",
        "schema.datatype_validity",
        "data.missing_values",
        "semantics.units_codebook",
        "semantics.mapping_status",
    ],
}


def expected(name: str, profile_id: str, previous: dict[str, object] | None) -> dict[str, object]:
    checks = {check: GOLDEN[name].get(check, "PASS") for check in PROFILE_CHECKS[profile_id]}
    return {
        "profile_id": profile_id,
        "profile_version": "1.0.0",
        "validator_version": VALIDATOR_VERSION,
        "overall_status": OVERALL[name][profile_id],
        "checks": checks,
        "result_sha256": previous.get("result_sha256") if previous else None,
    }


def write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def dump(obj: object) -> bytes:
    return (json.dumps(obj, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def main() -> None:
    lock: list[str] = []
    for name in FIXTURES:
        dataset, files = fixture_inputs(name)
        base = ROOT / name
        write(base / "dataset.json", dump(dataset))
        for rel, data in files.items():
            write(base / "files" / rel, data)
        for profile_id in PROFILE_CHECKS:
            target = base / "expected" / f"{profile_id}.json"
            previous = json.loads(target.read_text(encoding="utf-8")) if target.exists() else None
            write(target, dump(expected(name, profile_id, previous)))
        for path in [base / "dataset.json", *sorted((base / "files").rglob("*"))]:
            if path.is_file():
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                lock.append(f"{digest}  {path.relative_to(ROOT).as_posix()}")
    (ROOT / "fixtures.lock").write_text("\n".join(lock) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
