"""M05-AT-15: a 1 GB csv finishes within the run timeout with truncated=true (sample limits).

Opt-in (writes ~1 GB to tmp):  READINESS_PERF=1 uv run pytest apps/api/modules/readiness/tests/test_perf.py
READINESS_PERF_BYTES overrides the size (default 1 GiB).
"""

import os
import time
from pathlib import Path

import pytest

from api.modules.readiness.engine.evaluate import evaluate
from api.modules.readiness.fakes import FixtureCatalog
from api.modules.readiness.profile_registry import PROFILES
from api.modules.readiness.settings import ReadinessSettings
from api.modules.readiness.tests.helpers import ORG_B, clean_snapshot, fixture_files

pytestmark = pytest.mark.skipif(os.environ.get("READINESS_PERF") != "1", reason="set READINESS_PERF=1")


def _write_big_csv(path: Path, size: int) -> None:
    source = fixture_files()["data/measurements.csv"].decode().splitlines()
    header, rows = source[0], source[1:]
    block = ("\n".join(rows) + "\n").encode()
    with path.open("wb") as fh:
        fh.write((header + "\n").encode())
        while fh.tell() < size:
            fh.write(block)


def test_one_gigabyte_csv_is_sampled_and_completes(tmp_path: Path) -> None:
    size = int(os.environ.get("READINESS_PERF_BYTES", str(1 << 30)))
    big = tmp_path / "measurements.csv"
    _write_big_csv(big, size)
    files: dict[str, Path | bytes] = {
        k: v for k, v in fixture_files().items() if k != "data/measurements.csv"
    }
    files["data/measurements.csv"] = big
    catalog = FixtureCatalog()
    view = catalog.add_version(files, clean_snapshot(), owner_organization_id=ORG_B)
    started = time.monotonic()
    result = evaluate(view, PROFILES["TABULAR_ML_BASIC"], catalog, file_timeout_s=600)
    elapsed = time.monotonic() - started
    datatype = next(c for c in result.checks if c.check_id == "schema.datatype_validity")
    [file_evidence] = datatype.evidence["files"]
    assert file_evidence["truncated"] is True
    assert file_evidence["sampled_rows"] == PROFILES["TABULAR_ML_BASIC"].params.sample_max_rows
    assert result.overall_status == "PASS"  # repeated rows are valid data; checksum covers all 1 GB
    assert elapsed < ReadinessSettings().run_timeout_seconds
