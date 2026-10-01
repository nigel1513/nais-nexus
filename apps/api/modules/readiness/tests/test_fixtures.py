import hashlib
import importlib.util
import json
from dataclasses import replace
from types import ModuleType

import pytest

from api.modules.catalog.public import ObjectMissing
from api.modules.catalog.seed_files import fixture_files as catalog_fixture_files
from api.modules.readiness.engine import VALIDATOR_VERSION
from api.modules.readiness.engine.canonical import manifest_sha256
from api.modules.readiness.fakes import FIXTURES_ROOT, FixtureCatalog
from api.modules.readiness.tests.helpers import FIXTURE_NAMES, ORG_A, ORG_B, USERS


def _generator() -> ModuleType:
    spec = importlib.util.spec_from_file_location("readiness_fixture_generate", FIXTURES_ROOT / "generate.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_fixture_files_match_the_lock() -> None:
    entries = (FIXTURES_ROOT / "fixtures.lock").read_text(encoding="utf-8").splitlines()
    assert len(entries) == 4 * 5  # dataset.json + 4 files per fixture
    locked = set()
    for line in entries:
        digest, rel = line.split("  ", 1)
        locked.add(rel)
        assert hashlib.sha256((FIXTURES_ROOT / rel).read_bytes()).hexdigest() == digest, f"{rel} was modified"
    for name in FIXTURE_NAMES:
        for profile_id in ("GENERIC_BASIC", "TABULAR_ML_BASIC"):
            assert (FIXTURES_ROOT / name / "expected" / f"{profile_id}.json").is_file()
    on_disk = {
        p.relative_to(FIXTURES_ROOT).as_posix()
        for p in FIXTURES_ROOT.rglob("*")
        if p.is_file()
        and "__pycache__" not in p.parts
        and p.name not in ("generate.py", "fixtures.lock")
        and "expected" not in p.parts
    }
    assert on_disk == locked, "stray or missing fixture files"


def test_generator_reproduces_committed_inputs() -> None:
    generate = _generator()
    assert generate.VALIDATOR_VERSION == VALIDATOR_VERSION
    for name in FIXTURE_NAMES:
        dataset, files = generate.fixture_inputs(name)
        assert json.loads((FIXTURES_ROOT / name / "dataset.json").read_text(encoding="utf-8")) == dataset
        for rel, data in files.items():
            assert (FIXTURES_ROOT / name / "files" / rel).read_bytes() == data, f"{name}/{rel}"


def test_committed_files_equal_catalog_seed_files() -> None:
    """W1-D5: M03's seed_files generator is the single source of the fixture bytes (catalog seed == golden)."""
    for name in FIXTURE_NAMES:
        committed = {
            p.relative_to(FIXTURES_ROOT / name / "files").as_posix(): p.read_bytes()
            for p in sorted((FIXTURES_ROOT / name / "files").rglob("*"))
            if p.is_file()
        }
        assert committed == catalog_fixture_files(name), name


def test_measurements_csv_follows_the_formula() -> None:
    text = (FIXTURES_ROOT / "clean_tabular/files/data/measurements.csv").read_text(encoding="utf-8")
    lines = text.splitlines()
    assert lines[0] == "sample_id,material,temperature_c,pressure_kpa,measured_at"
    assert len(lines) == 1001
    assert lines[1] == "S0001,CU,20.5,102.325,2026-01-01T00:01:00Z"
    assert lines[100] == "S0100,CU,20.0,,2026-01-01T01:40:00Z"
    assert sum(1 for line in lines[1:] if line.split(",")[3] == "") == 10


def test_fake_catalog_serves_a_published_fixture() -> None:
    catalog = FixtureCatalog()
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    assert [f.path for f in view.files] == [
        "README.md",
        "_codebook.csv",
        "_schema.json",
        "data/measurements.csv",
    ]
    assert view.manifest_sha256 == manifest_sha256(view.files)
    assert view.metadata_snapshot is not None and view.metadata_snapshot["license"] == "CC-BY-4.0"
    ref = view.files[3]
    with catalog.open_stream(ref) as stream:
        assert hashlib.sha256(stream.read()).hexdigest() == ref.sha256
    assert catalog.get_version(view.dataset_version_id) == view


def test_fake_catalog_visibility_follows_d012() -> None:
    catalog = FixtureCatalog()
    internal = catalog.add_fixture("invalid_units", owner_organization_id=ORG_B, access_level="INTERNAL")
    controlled = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    assert not catalog.is_visible(USERS["a_researcher"], internal.dataset_id)
    assert catalog.is_visible(USERS["b_researcher"], internal.dataset_id)
    assert catalog.is_visible(USERS["admin"], internal.dataset_id)
    assert catalog.is_visible(USERS["a_researcher"], controlled.dataset_id)
    draft = catalog.add_version({}, None, owner_organization_id=ORG_A, status="DRAFT")
    assert draft.metadata_snapshot is None and draft.manifest_sha256 is None


def test_fake_catalog_policy_view_satisfies_the_m03_port() -> None:
    catalog = FixtureCatalog()
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    policy = catalog.get_policy_view(view.dataset_id)
    assert policy is not None and policy.owner_organization_id == ORG_B
    assert (policy.access_level, policy.status) == ("CONTROLLED", "ACTIVE")
    assert policy.title == "고분자 전해질 막 온도-압력 측정"
    assert catalog.get_policy_view(ORG_A) is None


def test_visibility_matches_m03_can_see_dataset() -> None:
    catalog = FixtureCatalog()
    withdrawn = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    catalog.withdraw_dataset(withdrawn.dataset_id)
    assert catalog.is_visible(USERS["b_researcher"], withdrawn.dataset_id)
    assert catalog.is_visible(USERS["admin"], withdrawn.dataset_id)
    assert not catalog.is_visible(USERS["a_researcher"], withdrawn.dataset_id)
    policy = catalog.get_policy_view(withdrawn.dataset_id)
    assert policy is not None and policy.status == "WITHDRAWN"
    draft = catalog.add_version(
        {}, None, owner_organization_id=ORG_B, status="DRAFT", access_level="CONTROLLED"
    )
    assert not catalog.is_visible(USERS["a_researcher"], draft.dataset_id)
    assert catalog.is_visible(USERS["b_steward"], draft.dataset_id)
    internal = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B, access_level="INTERNAL")
    assert not catalog.is_visible(USERS["a_researcher"], internal.dataset_id)
    assert not catalog.is_visible(USERS["a_researcher"], ORG_A)


def test_withdrawn_version_keeps_snapshot_and_manifest() -> None:
    catalog = FixtureCatalog()
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B, status="WITHDRAWN")
    assert view.metadata_snapshot is not None and view.manifest_sha256 == manifest_sha256(view.files)


def test_default_ids_are_deterministic() -> None:
    first = FixtureCatalog().add_fixture("clean_tabular", owner_organization_id=ORG_B)
    second = FixtureCatalog().add_fixture("clean_tabular", owner_organization_id=ORG_B)
    assert (first.dataset_id, first.dataset_version_id) == (second.dataset_id, second.dataset_version_id)


def test_open_stream_mirrors_m03_semantics() -> None:
    catalog = FixtureCatalog()
    view = catalog.add_version({"a.csv": b"0123456789"}, {"title": "t"}, owner_organization_id=ORG_B)
    ref = view.files[0]
    assert catalog.open_stream(ref, (2, 4)).read() == b"234"
    for bad in ((-1, 3), (5, 2)):
        with pytest.raises(ValueError):
            catalog.open_stream(ref, bad)
    # DRAFT version
    draft = catalog.add_version({"a.csv": b"x"}, None, owner_organization_id=ORG_B, status="DRAFT")
    with pytest.raises(ObjectMissing):
        catalog.open_stream(draft.files[0])
    # unverified file
    catalog.replace_view(replace(view, files=(replace(ref, status="UPLOADED"),)))
    with pytest.raises(ObjectMissing):
        catalog.open_stream(ref)
    catalog.replace_view(view)
    # bucket/key mismatch
    with pytest.raises(ObjectMissing):
        catalog.open_stream(replace(ref, storage_bucket="other"))
    with pytest.raises(ObjectMissing):
        catalog.open_stream(replace(ref, storage_key="datasets/x"))
    # deleted object, then storage outage raises first
    catalog.delete_object(view.dataset_version_id, "a.csv")
    with pytest.raises(ObjectMissing):
        catalog.open_stream(ref)
    catalog.fail_reads = RuntimeError("down")
    with pytest.raises(RuntimeError, match="down"):
        catalog.open_stream(ref)
