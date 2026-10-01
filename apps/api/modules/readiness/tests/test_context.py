import dataclasses
import io
import json
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from api.modules.readiness.catalog_port import StorageUnavailable
from api.modules.readiness.engine import context as context_module
from api.modules.readiness.engine.context import EvaluationContext
from api.modules.readiness.engine.parsing import FileTimeout, FileTooLarge
from api.modules.readiness.fakes import FIXTURES_ROOT, FixtureCatalog
from api.modules.readiness.tests.builders import make_ctx
from api.modules.readiness.tests.helpers import FIXTURE_NAMES, fixture_files
from api.modules.readiness.validators import license_usage, metadata_completeness, provenance_presence

CSV = b"a,b\n1,2\n3,4\n"


def _csv_ctx(**kw: Any) -> tuple[EvaluationContext, FixtureCatalog]:
    catalog = FixtureCatalog()
    return make_ctx(files={"data/t.csv": CSV}, catalog=catalog, **kw), catalog


class _Ticking:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        self.now += 10.0
        return self.now


def test_file_timeout_is_cached_and_file_parsed_once() -> None:
    ctx, catalog = _csv_ctx()
    ctx = dataclasses.replace(ctx, file_timeout_s=1.0, monotonic=_Ticking())
    for _ in range(3):
        with pytest.raises(FileTimeout):
            ctx.file_stats("data/t.csv")
    assert catalog.reads == ["data/t.csv"]


def test_file_too_large_is_cached(monkeypatch: pytest.MonkeyPatch) -> None:
    ctx, _ = _csv_ctx()
    calls = []

    def boom(*a: Any, **k: Any) -> Any:
        calls.append(1)
        raise FileTooLarge()

    monkeypatch.setattr(context_module, "profile_csv", boom)
    for _ in range(3):
        with pytest.raises(FileTooLarge):
            ctx.file_stats("data/t.csv")
    assert len(calls) == 1


def test_header_error_outcome_is_cached() -> None:
    catalog = FixtureCatalog()
    ctx = make_ctx(files={"data/t.csv": b"\n1,2\n"}, catalog=catalog)
    first = ctx.file_stats("data/t.csv")
    assert first.header_error is True
    assert ctx.file_stats("data/t.csv") is first
    assert catalog.reads == ["data/t.csv"]


def test_storage_errors_are_not_cached() -> None:
    ctx, catalog = _csv_ctx()
    catalog.fail_reads = StorageUnavailable("down")
    with pytest.raises(StorageUnavailable):
        ctx.file_stats("data/t.csv")
    catalog.fail_reads = None
    assert ctx.file_stats("data/t.csv").header_error is False
    assert catalog.reads == ["data/t.csv"]


def test_parquet_shares_one_deadline_per_file(monkeypatch: pytest.MonkeyPatch) -> None:
    buf = io.BytesIO()
    pq.write_table(pa.table({"a": [1, 2]}), buf)
    ctx = make_ctx(files={"data/t.parquet": buf.getvalue()})
    made = []
    original = ctx.new_deadline

    def counting() -> Any:
        made.append(1)
        return original()

    monkeypatch.setattr(ctx, "new_deadline", counting)
    ctx.file_stats("data/t.parquet")
    assert len(made) == 1


class _Trickle(io.RawIOBase):
    def __init__(self, data: bytes) -> None:
        self._buf = io.BytesIO(data)

    def readable(self) -> bool:
        return True

    def readinto(self, b: Any) -> int:
        return self._buf.readinto(memoryview(b)[:3])


class _TrickleCatalog(FixtureCatalog):
    def open_stream(self, file: Any, byte_range: Any = None) -> Any:
        return _Trickle(super().open_stream(file, byte_range).read())


def test_read_small_loops_over_short_reads(monkeypatch: pytest.MonkeyPatch) -> None:
    catalog = _TrickleCatalog()
    ctx = make_ctx(catalog=catalog)
    assert ctx.read_small("README.md") == fixture_files()["README.md"]
    size = len(fixture_files()["README.md"])
    monkeypatch.setattr(context_module, "CONVENTION_MAX_BYTES", size)
    assert ctx.read_small("README.md") == fixture_files()["README.md"]
    monkeypatch.setattr(context_module, "CONVENTION_MAX_BYTES", size - 1)
    assert ctx.read_small("README.md") is None


GOLDEN = {  # 09 §5.6
    "clean_tabular": ("PASS", "PASS", "PASS"),
    "missing_metadata": ("FAIL", "PASS", "PASS"),
    "invalid_units": ("PASS", "PASS", "PASS"),
    "missing_provenance": ("PASS", "FAIL", "PASS"),
}


@pytest.mark.parametrize("name", FIXTURE_NAMES)
def test_metadata_checks_match_golden_over_fixture_dirs(name: str) -> None:
    snapshot = json.loads((FIXTURES_ROOT / name / "dataset.json").read_text(encoding="utf-8"))
    ctx = make_ctx(files=fixture_files(name), snapshot=snapshot)
    got = (
        metadata_completeness.check(ctx).status,
        provenance_presence.check(ctx).status,
        license_usage.check(ctx).status,
    )
    assert got == GOLDEN[name]
