import dataclasses

import pytest

from api.modules.readiness.catalog_port import ObjectMissing
from api.modules.readiness.engine.parsing import FileTimeout
from api.modules.readiness.fakes import FixtureCatalog
from api.modules.readiness.tests.builders import make_ctx
from api.modules.readiness.tests.helpers import fixture_files
from api.modules.readiness.validators import file_checksum


def test_checksum_pass_recomputes_every_file() -> None:
    catalog = FixtureCatalog()
    outcome = file_checksum.check(make_ctx(catalog=catalog))
    assert outcome.status == "PASS"
    assert outcome.evidence == {
        "files_total": 4,
        "recomputed": 4,
        "catalog_verified": 0,
        "mismatched": [],
        "not_verified": [],
        "missing": [],
        "manifest_match": True,
    }
    assert sorted(catalog.reads) == ["README.md", "_codebook.csv", "_schema.json", "data/measurements.csv"]


def test_checksum_fail_on_content_mismatch() -> None:
    ctx = make_ctx()
    tampered = tuple(
        dataclasses.replace(f, sha256="0" * 64) if f.path == "_schema.json" else f for f in ctx.files
    )
    outcome = file_checksum.check(dataclasses.replace(ctx, files=tampered))
    assert outcome.status == "FAIL"
    assert outcome.evidence["mismatched"] == ["_schema.json"]
    assert outcome.evidence["manifest_match"] is False  # the manifest was computed from the true sha256


def test_checksum_fail_on_manifest_mismatch() -> None:
    outcome = file_checksum.check(dataclasses.replace(make_ctx(), manifest_sha256="f" * 64))
    assert (outcome.status, outcome.evidence["manifest_match"]) == ("FAIL", False)


def test_files_beyond_budget_use_catalog_verified_status() -> None:
    files = fixture_files()
    budget = len(files["README.md"]) + len(
        files["_codebook.csv"]
    )  # path order: README.md, _codebook.csv, ...
    catalog = FixtureCatalog()
    ctx = make_ctx(catalog=catalog, checksum_max_total_bytes=budget)
    outcome = file_checksum.check(ctx)
    assert (outcome.status, outcome.evidence["recomputed"], outcome.evidence["catalog_verified"]) == (
        "PASS",
        2,
        2,
    )
    assert sorted(catalog.reads) == ["README.md", "_codebook.csv"]
    unverified = tuple(
        dataclasses.replace(f, status="UPLOADED") if f.path == "data/measurements.csv" else f
        for f in ctx.files
    )
    outcome = file_checksum.check(dataclasses.replace(ctx, files=unverified))
    assert (outcome.status, outcome.evidence["not_verified"]) == ("FAIL", ["data/measurements.csv"])


def test_missing_object_propagates_instead_of_verdict() -> None:
    catalog = FixtureCatalog()
    catalog.fail_reads = ObjectMissing("gone")
    with pytest.raises(ObjectMissing):
        file_checksum.check(make_ctx(catalog=catalog))


def test_hashing_streams_in_bounded_chunks(monkeypatch: pytest.MonkeyPatch) -> None:
    sizes: list[int] = []
    catalog = FixtureCatalog()
    ctx = make_ctx(catalog=catalog)
    original = catalog.open_stream

    class Spy:
        def __init__(self, inner: object) -> None:
            self._inner = inner

        def __enter__(self) -> "Spy":
            self._inner.__enter__()  # type: ignore[attr-defined]
            return self

        def __exit__(self, *a: object) -> None:
            self._inner.__exit__(*a)  # type: ignore[attr-defined]

        def read(self, n: int = -1) -> bytes:
            sizes.append(n)
            return self._inner.read(n)  # type: ignore[attr-defined, no-any-return]

    monkeypatch.setattr(catalog, "open_stream", lambda *a, **k: Spy(original(*a, **k)))
    monkeypatch.setattr(file_checksum, "CHUNK", 7)
    assert file_checksum.check(ctx).status == "PASS"
    assert sizes and all(0 < n <= 7 for n in sizes)


def test_hashing_checks_the_file_deadline() -> None:
    class Ticking:
        now = 0.0

        def __call__(self) -> float:
            self.now += 10.0
            return self.now

    ctx = dataclasses.replace(make_ctx(), file_timeout_s=1.0, monotonic=Ticking())
    with pytest.raises(FileTimeout):
        file_checksum.check(ctx)


def test_manifest_comparison_ignores_hex_case() -> None:
    ctx = make_ctx()
    assert ctx.manifest_sha256 is not None
    outcome = file_checksum.check(dataclasses.replace(ctx, manifest_sha256=ctx.manifest_sha256.upper()))
    assert (outcome.status, outcome.evidence["manifest_match"]) == ("PASS", True)
