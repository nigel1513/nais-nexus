"""Aggregation (09 §2.4), M05-AT-01 at engine level, M05-AT-02 determinism, M05-AT-13, M05-AT-14."""

import ast
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from api.modules.readiness.engine import VALIDATOR_VERSION
from api.modules.readiness.engine.evaluate import (
    CheckResult,
    evaluate,
    overall_status,
    result_sha256,
    summarize,
)
from api.modules.readiness.fakes import FIXTURES_ROOT, FixtureCatalog
from api.modules.readiness.profile_registry import PROFILES
from api.modules.readiness.selfcheck import run_fixture
from api.modules.readiness.tests.helpers import FIXTURE_NAMES, ORG_B, clean_snapshot
from api.platform.settings import REPO_ROOT

MODULE_DIR = Path(__file__).resolve().parents[1]


def _check(status: str, severity: str = "REQUIRED", check_id: str = "c") -> CheckResult:
    return CheckResult(check_id, 1, severity, status, "m", {})  # type: ignore[arg-type]


def _expected(name: str, profile_id: str) -> dict[str, Any]:
    path = FIXTURES_ROOT / name / "expected" / f"{profile_id}.json"
    return json.loads(path.read_text(encoding="utf-8"))  # type: ignore[no-any-return]


# ---------------------------------------------------------------- aggregation


@pytest.mark.parametrize(
    ("checks", "expected"),
    [
        ([_check("PASS"), _check("NOT_APPLICABLE")], "PASS"),
        ([_check("PASS"), _check("WARNING")], "WARNING"),
        ([_check("PASS"), _check("FAIL", "RECOMMENDED")], "WARNING"),
        ([_check("WARNING"), _check("FAIL", "REQUIRED")], "FAIL"),
    ],
)
def test_overall_aggregation_09_section_2_4(checks: list[CheckResult], expected: str) -> None:
    assert overall_status(checks) == expected


def test_summary_counts_every_status() -> None:
    checks = [_check("PASS"), _check("PASS"), _check("WARNING"), _check("FAIL"), _check("NOT_APPLICABLE")]
    assert summarize(checks) == {"pass": 2, "warning": 1, "fail": 1, "not_applicable": 1}


def test_result_sha256_covers_checks_overall_and_summary() -> None:
    checks = [_check("PASS")]
    summary = summarize(checks)
    first = result_sha256(checks, "PASS", summary)
    assert first == result_sha256(list(checks), "PASS", dict(summary))
    assert first != result_sha256(checks, "WARNING", summary)
    assert first != result_sha256([_check("PASS", check_id="d")], "PASS", summary)


# ---------------------------------------------------------------- golden


@pytest.mark.parametrize("profile_id", ["GENERIC_BASIC", "TABULAR_ML_BASIC"])
@pytest.mark.parametrize("name", FIXTURE_NAMES)
def test_golden_output(name: str, profile_id: str) -> None:
    expected = _expected(name, profile_id)
    result = run_fixture(FIXTURES_ROOT, name, profile_id)
    assert {c.check_id: c.status for c in result.checks} == expected["checks"]
    assert result.overall_status == expected["overall_status"]
    assert (result.profile_version, result.validator_version) == (
        expected["profile_version"],
        VALIDATOR_VERSION,
    )
    assert expected["validator_version"] == VALIDATOR_VERSION
    assert expected["result_sha256"], "record it: python -m api.modules.readiness.selfcheck --record"
    assert result.result_sha256 == expected["result_sha256"], (
        "result changed: bump VALIDATOR_VERSION (or the profile version) and re-record the golden sha256"
    )


def test_golden_table_09_section_5_6() -> None:
    """The hand-written verdicts, independent of generate.py."""
    overall = {(n, p): _expected(n, p)["overall_status"] for n in FIXTURE_NAMES for p in PROFILES}
    assert overall == {
        ("clean_tabular", "GENERIC_BASIC"): "PASS",
        ("clean_tabular", "TABULAR_ML_BASIC"): "PASS",
        ("missing_metadata", "GENERIC_BASIC"): "FAIL",
        ("missing_metadata", "TABULAR_ML_BASIC"): "FAIL",
        ("invalid_units", "GENERIC_BASIC"): "WARNING",
        ("invalid_units", "TABULAR_ML_BASIC"): "FAIL",
        ("missing_provenance", "GENERIC_BASIC"): "FAIL",
        ("missing_provenance", "TABULAR_ML_BASIC"): "FAIL",
    }
    assert _expected("invalid_units", "TABULAR_ML_BASIC")["checks"]["semantics.units_codebook"] == "FAIL"
    assert _expected("missing_provenance", "GENERIC_BASIC")["checks"]["provenance.presence"] == "FAIL"
    assert _expected("missing_metadata", "GENERIC_BASIC")["checks"]["metadata.completeness"] == "FAIL"
    assert "schema.datatype_validity" not in _expected("clean_tabular", "GENERIC_BASIC")["checks"]


_CHILD = """
import dramatiq
from dramatiq.brokers.stub import StubBroker
dramatiq.set_broker(StubBroker())
from api.modules.readiness.fakes import FIXTURES_ROOT
from api.modules.readiness.selfcheck import run_fixture
print(run_fixture(FIXTURES_ROOT, "clean_tabular", "TABULAR_ML_BASIC").result_sha256)
"""


def test_determinism_across_worker_processes() -> None:
    """M05-AT-02: three separate processes (different hash seeds) -> identical result_sha256 = golden."""
    shas = set()
    for seed in ("1", "2", "random"):
        env = {
            **os.environ,
            "PYTHONPATH": os.pathsep.join(
                [str(REPO_ROOT / "apps"), str(REPO_ROOT / "packages/contracts/python")]
            ),
            "PYTHONHASHSEED": seed,
        }
        out = subprocess.run(
            [sys.executable, "-c", _CHILD], env=env, cwd=REPO_ROOT, capture_output=True, text=True, check=True
        )
        shas.add(out.stdout.strip())
    assert shas == {_expected("clean_tabular", "TABULAR_ML_BASIC")["result_sha256"]}


def test_no_tabular_files_makes_t_dependent_checks_not_applicable() -> None:
    """M05-AT-13 at engine level: README.md + .h5 only."""
    catalog = FixtureCatalog()
    readme = (
        "# Scan\n\n## Provenance\n\n"
        + "빔라인 BL-7에서 2026년 3월 측정한 원시 HDF5 스캔 파일이며 후처리하지 않았다. " * 2
    )
    view = catalog.add_version(
        {"README.md": readme.encode(), "raw/scan.h5": b"\x89HDF\r\n\x1a\n" + bytes(64)},
        clean_snapshot(),
        owner_organization_id=ORG_B,
    )
    result = evaluate(view, PROFILES["TABULAR_ML_BASIC"], catalog)
    statuses = {c.check_id: c.status for c in result.checks}
    for check_id in (
        "schema.presence",
        "schema.datatype_validity",
        "data.missing_values",
        "semantics.units_codebook",
        "semantics.mapping_status",
    ):
        assert statuses[check_id] == "NOT_APPLICABLE", check_id
    assert result.overall_status == "PASS"
    assert result.summary == {"pass": 4, "warning": 0, "fail": 0, "not_applicable": 5}


def test_evidence_and_messages_never_contain_cell_values() -> None:
    """D-018 at engine level: no fixture cell value appears anywhere in any result."""
    lines = (
        (FIXTURES_ROOT / "clean_tabular/files/data/measurements.csv").read_text(encoding="utf-8").splitlines()
    )
    rows = [line.split(",") for line in lines[1:]]
    cells = {cell for row in rows for cell in (row[0], row[3], row[4]) if cell}  # S0001, 101.325, timestamps
    for name in FIXTURE_NAMES:
        for profile_id in PROFILES:
            result = run_fixture(FIXTURES_ROOT, name, profile_id)
            text = json.dumps([c.to_api() for c in result.checks], ensure_ascii=False)
            leaked = sorted(cell for cell in cells if cell in text)
            assert not leaked, f"{name}/{profile_id} leaks {leaked[:3]}"


# ---------------------------------------------------------------- M05-AT-14 lint rules

NETWORK_OR_LLM = {"anthropic", "openai", "httpx", "requests", "urllib", "aiohttp", "socket"}
IMPURE_MODULES = {"random", "secrets", "time", "os", "datetime", "uuid"}
IMPURE_CALLS = {
    "now",
    "utcnow",
    "today",
    "time",
    "time_ns",
    "monotonic",
    "perf_counter",
    "getenv",
    "uuid4",
    "random",
}


def _imports(tree: ast.AST) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names |= {alias.name.split(".")[0] for alias in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module.split(".")[0])
    return names


def test_module_imports_no_llm_or_http_client() -> None:
    for path in MODULE_DIR.rglob("*.py"):
        if "tests" in path.relative_to(MODULE_DIR).parts:
            continue
        bad = _imports(ast.parse(path.read_text(encoding="utf-8"))) & NETWORK_OR_LLM
        assert not bad, f"{path.relative_to(MODULE_DIR)} imports {bad}"


def test_validators_do_not_read_clock_randomness_or_env() -> None:
    targets = [
        *(MODULE_DIR / "validators").glob("*.py"),
        MODULE_DIR / "engine" / "units.py",
        MODULE_DIR / "engine" / "canonical.py",
        MODULE_DIR / "engine" / "evaluate.py",
    ]
    for path in targets:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        assert not _imports(tree) & IMPURE_MODULES, f"{path.name} imports {_imports(tree) & IMPURE_MODULES}"
        calls = {
            n.func.attr
            for n in ast.walk(tree)
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
        }
        assert not calls & IMPURE_CALLS, f"{path.name} calls {calls & IMPURE_CALLS}"


# ---------------------------------------------------------------- failure mapping / order independence


def test_file_timeout_and_too_large_propagate_not_verdicts(monkeypatch: pytest.MonkeyPatch) -> None:
    """M05 §5: FILE_TIMEOUT fails the run; FileTooLarge likewise cannot be a verdict -> both propagate."""
    from api.modules.readiness.engine import context as ctx_module
    from api.modules.readiness.engine.parsing import FileTimeout, FileTooLarge

    for exc in (FileTimeout(), FileTooLarge()):

        def boom(self: object, path: str, _exc: Exception = exc) -> None:
            raise _exc

        monkeypatch.setattr(ctx_module.EvaluationContext, "file_stats", boom)
        catalog = FixtureCatalog()
        view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
        with pytest.raises(type(exc)):
            evaluate(view, PROFILES["TABULAR_ML_BASIC"], catalog)


def test_storage_errors_propagate() -> None:
    from api.modules.readiness.catalog_port import ObjectMissing

    catalog = FixtureCatalog()
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    catalog.delete_object(view.dataset_version_id, "data/measurements.csv")
    with pytest.raises(ObjectMissing):
        evaluate(view, PROFILES["TABULAR_ML_BASIC"], catalog)


def test_result_independent_of_file_and_key_order() -> None:
    from dataclasses import replace

    catalog = FixtureCatalog()
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    shuffled = replace(
        view,
        files=tuple(reversed(view.files)),
        metadata_snapshot=dict(reversed(list((view.metadata_snapshot or {}).items()))),
    )
    for profile in PROFILES.values():
        a = evaluate(view, profile, catalog)
        b = evaluate(shuffled, profile, catalog)
        assert a == b
        assert a.result_sha256 == b.result_sha256
