import csv
import hashlib
import io
import json
from uuid import UUID

from api.modules.catalog.public import CatalogQueryPort
from api.modules.catalog.seed import seed
from api.modules.catalog.seed_data import SEED_DATASETS
from api.modules.catalog.seed_files import FIXTURES, fixture_files, measurements_csv
from api.modules.catalog.testing import memory_store
from api.modules.catalog.tests.support import outbox_events, rows
from api.modules.catalog.tests.support_api import USERS, CatalogApi
from api.platform import ports
from api.platform.db import session_factory
from api.platform.testing.contracts import assert_valid_event
from api.platform.testing.fixtures import PgUrls


def run_seed(db: PgUrls) -> None:
    with session_factory(db.app)() as session, session.begin():
        seed(session)


def test_measurements_follow_the_fixture_formula() -> None:
    reader = list(csv.reader(io.StringIO(measurements_csv().decode())))
    assert reader[0] == ["sample_id", "material", "temperature_c", "pressure_kpa", "measured_at"]
    assert len(reader) == 1001
    assert reader[1] == ["S0001", "CU", "20.5", "102.325", "2026-01-01T00:01:00Z"]
    assert reader[100] == ["S0100", "CU", "20.0", "", "2026-01-01T01:40:00Z"]
    assert sum(1 for row in reader[1:] if row[3] == "") == 10


def test_fixture_variants() -> None:
    clean = fixture_files("clean_tabular")
    assert sorted(clean) == ["README.md", "_codebook.csv", "_schema.json", "data/measurements.csv"]
    schema = json.loads(fixture_files("invalid_units")["_schema.json"])["resources"][0]
    assert schema["path"] == "data/measurements.csv"
    units = {f["name"]: f.get("unit") for f in schema["schema"]["fields"]}
    assert (units["temperature_c"], units["pressure_kpa"]) == ("degC", "kilopascal")
    assert clean["_codebook.csv"].decode().splitlines()[0] == "path,field,code,label,unit,description"
    assert "## Provenance" in clean["README.md"].decode()
    assert "## Provenance" not in fixture_files("missing_provenance")["README.md"].decode()


def test_seed_is_idempotent_and_matches_10_seed_data(api: CatalogApi, db: PgUrls) -> None:
    run_seed(db)
    run_seed(db)
    datasets = {r["dataset_id"]: r for r in rows(db, "SELECT * FROM catalog.datasets")}
    assert {str(i)[-4:] for i in datasets} == {"2001", "2002", "2003", "2004", "2005"}
    by_suffix = {str(i)[-4:]: r for i, r in datasets.items()}
    assert (by_suffix["2001"]["access_level"], by_suffix["2001"]["max_grant_days"]) == ("CONTROLLED", 180)
    assert (by_suffix["2002"]["access_level"], len(by_suffix["2002"]["allowed_purposes"])) == ("PUBLIC", 5)
    assert by_suffix["2003"]["access_level"] == "INTERNAL"
    assert (by_suffix["2004"]["access_level"], by_suffix["2004"]["max_grant_days"]) == ("SENSITIVE", 30)
    assert by_suffix["2004"]["description"] == "측정 데이터" and by_suffix["2004"]["keywords"] == []
    assert by_suffix["2002"]["provenance"] is None
    versions = rows(
        db, "SELECT dataset_id, status, file_count FROM catalog.dataset_versions ORDER BY dataset_id"
    )
    assert [(str(v["dataset_id"])[-4:], v["status"], v["file_count"]) for v in versions] == [
        ("2001", "PUBLISHED", 4),
        ("2002", "PUBLISHED", 4),
        ("2003", "PUBLISHED", 4),
        ("2004", "PUBLISHED", 4),
        ("2005", "DRAFT", 0),
    ]
    assert rows(db, "SELECT count(*) AS n FROM catalog.dataset_files WHERE status = 'VERIFIED'")[0]["n"] == 16
    events = outbox_events(db)
    assert [e["event_type"] for e in events].count("catalog.dataset.created.v1") == 5
    assert [e["event_type"] for e in events].count("catalog.dataset.version_published.v1") == 4
    for event in events:
        assert_valid_event(event)
    steward_b = str(USERS["b.steward"].user_id)
    assert {
        e["actor"]["user_id"]
        for e in events
        if e["payload"].get("owner_organization_id") == str(by_suffix["2001"]["owner_organization_id"])
    } == {steward_b}
    assert len(memory_store(api.deps.storage, "inst-b").objects) == 12
    assert len(memory_store(api.deps.storage, "inst-a").objects) == 4


def test_seed_check_visibility(api: CatalogApi, db: PgUrls) -> None:  # 10_SEED_DATA §7 (metadata part)
    run_seed(db)
    port = ports.get(CatalogQueryPort)
    visible_to_a = {
        s.dataset_id for s in SEED_DATASETS if port.is_visible(USERS["a.researcher"], s.dataset_id)
    }
    visible_to_b = {
        s.dataset_id for s in SEED_DATASETS if port.is_visible(USERS["b.researcher"], s.dataset_id)
    }
    suffix = lambda ids: {str(i)[-4:] for i in ids}  # noqa: E731
    assert suffix(visible_to_a) == {"2001", "2002", "2004", "2005"}
    assert suffix(visible_to_b) == {"2001", "2002", "2003", "2004"}
    view = port.get_version(UUID("00000000-0000-7000-8000-000000002101"))
    assert view is not None and view.metadata_snapshot is not None
    assert view.metadata_snapshot["title"] == "Battery Cycling Measurements"


# W1-D5 golden: M05 imports fixture_files(); any byte change here silently breaks its readiness fixtures.
GOLDEN_SHA256 = {
    "clean_tabular": {
        "README.md": ("88be8b70c07a95412db9b0b0ca1d2dc4bcd14be5755af580d6f2c820b182c7aa"),
        "_codebook.csv": ("4265d09fed27a06f91d28383236e6757a520a2f4c9fd538c0383d832ee0489a9"),
        "_schema.json": ("9491e70abaf9671da301335707a9b63f4c049f3c4b8a9f1fe1e111ba7f7251e3"),
        "data/measurements.csv": ("eab038a6519381749bdf1fe3363c99baecbeeb349ed3b568c8524bd131127300"),
    },
    "missing_metadata": {
        "README.md": ("88be8b70c07a95412db9b0b0ca1d2dc4bcd14be5755af580d6f2c820b182c7aa"),
        "_codebook.csv": ("4265d09fed27a06f91d28383236e6757a520a2f4c9fd538c0383d832ee0489a9"),
        "_schema.json": ("9491e70abaf9671da301335707a9b63f4c049f3c4b8a9f1fe1e111ba7f7251e3"),
        "data/measurements.csv": ("eab038a6519381749bdf1fe3363c99baecbeeb349ed3b568c8524bd131127300"),
    },
    "invalid_units": {
        "README.md": ("88be8b70c07a95412db9b0b0ca1d2dc4bcd14be5755af580d6f2c820b182c7aa"),
        "_codebook.csv": ("4265d09fed27a06f91d28383236e6757a520a2f4c9fd538c0383d832ee0489a9"),
        "_schema.json": ("a33e0ca6cd0dadd9b080cd581d6aa1ffc094a93817c0f924a9694fc954e6b95a"),
        "data/measurements.csv": ("eab038a6519381749bdf1fe3363c99baecbeeb349ed3b568c8524bd131127300"),
    },
    "missing_provenance": {
        "README.md": ("66c0ef10e36611103c3d660e1ac4de37a753267fbd7a4ce887b768c66f753d28"),
        "_codebook.csv": ("4265d09fed27a06f91d28383236e6757a520a2f4c9fd538c0383d832ee0489a9"),
        "_schema.json": ("9491e70abaf9671da301335707a9b63f4c049f3c4b8a9f1fe1e111ba7f7251e3"),
        "data/measurements.csv": ("eab038a6519381749bdf1fe3363c99baecbeeb349ed3b568c8524bd131127300"),
    },
}


def test_fixture_files_match_the_pinned_digests() -> None:
    assert set(GOLDEN_SHA256) == set(FIXTURES)
    for fixture in FIXTURES:
        actual = {path: hashlib.sha256(data).hexdigest() for path, data in fixture_files(fixture).items()}
        assert actual == GOLDEN_SHA256[fixture], fixture
