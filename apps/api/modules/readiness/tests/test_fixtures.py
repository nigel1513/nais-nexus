import hashlib
import importlib.util
import json
from types import ModuleType

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
    for line in entries:
        digest, rel = line.split("  ", 1)
        assert hashlib.sha256((FIXTURES_ROOT / rel).read_bytes()).hexdigest() == digest, f"{rel} was modified"


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
