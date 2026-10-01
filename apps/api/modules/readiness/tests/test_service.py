"""Queueing rules (M05 §6.2 steps 5-7), auto profile choice (§3.2), reads and ReadinessQueryPort (§8)."""

import ast
import subprocess
import sys
import threading
import uuid
from pathlib import Path
from typing import Any

import pytest

from api.modules.readiness import jobs, service
from api.modules.readiness.catalog_port import StorageUnavailable, VersionView
from api.modules.readiness.engine import VALIDATOR_VERSION
from api.modules.readiness.engine.canonical import input_fingerprint
from api.modules.readiness.fakes import FixtureCatalog
from api.modules.readiness.profile_registry import PROFILES
from api.modules.readiness.public import ReadinessQueryPort
from api.modules.readiness.query import wire
from api.modules.readiness.service import RequestOutcome, auto_profiles, fingerprint_for, request_validation
from api.modules.readiness.tests.dbutil import CORRELATION, queued_messages, row
from api.modules.readiness.tests.helpers import ORG_B, USERS, clean_snapshot
from api.platform import ports
from api.platform.auth import CurrentUser
from api.platform.db import session_factory
from api.platform.testing.fixtures import PgUrls


def request(
    db: PgUrls, view: VersionView, profile_id: str = "TABULAR_ML_BASIC", requester: CurrentUser | None = None
) -> RequestOutcome:
    with session_factory(db.app)() as session, session.begin():
        return request_validation(
            session,
            view,
            PROFILES[profile_id],
            triggered_by="USER" if requester else "AUTO_ON_PUBLISH",
            requester=requester,
            correlation_id=CORRELATION,
        )


def test_fingerprint_uses_manifest_snapshot_and_versions(catalog: FixtureCatalog) -> None:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    assert view.manifest_sha256 is not None and view.metadata_snapshot is not None
    expected = input_fingerprint(
        view.manifest_sha256, view.metadata_snapshot, "GENERIC_BASIC", "1.0.0", VALIDATOR_VERSION
    )
    assert fingerprint_for(view, PROFILES["GENERIC_BASIC"]) == expected
    draft = catalog.add_version({}, None, owner_organization_id=ORG_B, status="DRAFT")
    with pytest.raises(ValueError):
        fingerprint_for(draft, PROFILES["GENERIC_BASIC"])


def test_auto_profiles_follow_tabular_set(catalog: FixtureCatalog) -> None:
    tabular = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    assert [p.profile_id for p in auto_profiles(tabular)] == ["GENERIC_BASIC", "TABULAR_ML_BASIC"]
    files = {"README.md": b"# x\n", "raw/scan.h5": b"\x89HDF", "_notes.csv": b"a\n"}
    other = catalog.add_version(files, clean_snapshot(), owner_organization_id=ORG_B)
    assert [p.profile_id for p in auto_profiles(other)] == ["GENERIC_BASIC"]


def test_request_queues_then_reports_in_progress(db: PgUrls, catalog: FixtureCatalog) -> None:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    first = request(db, view, requester=USERS["b_steward"])
    assert first.kind == "QUEUED"
    stored = row(db, first.row["validation_id"])
    assert (stored["run_status"], stored["attempt"], stored["triggered_by"]) == ("QUEUED", 0, "USER")
    assert (stored["requested_by"], stored["correlation_id"]) == (USERS["b_steward"].user_id, CORRELATION)
    second = request(db, view)
    assert (second.kind, second.row["validation_id"]) == ("IN_PROGRESS", first.row["validation_id"])
    assert len(queued_messages()) == 1


def test_completed_result_is_reused_without_new_rows(db: PgUrls, catalog: FixtureCatalog) -> None:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    first = request(db, view, "GENERIC_BASIC")
    jobs.run_validation(first.row["validation_id"])
    again = request(db, view, "GENERIC_BASIC")
    assert (again.kind, again.row["validation_id"]) == ("REUSED", first.row["validation_id"])
    assert len(queued_messages()) == 1


def test_failed_run_is_never_reused_and_recovers(db: PgUrls, catalog: FixtureCatalog) -> None:
    """M05-AT-10 second half: after the outage a new request runs to COMPLETED."""
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    first = request(db, view)
    catalog.fail_reads = StorageUnavailable("down")
    for _ in range(2):
        with pytest.raises(jobs.RetryableInfraError):
            jobs.run_validation(first.row["validation_id"])
    assert jobs.run_validation(first.row["validation_id"]) == "FAILED"
    catalog.fail_reads = None
    retry = request(db, view)
    assert retry.kind == "QUEUED"
    assert jobs.run_validation(retry.row["validation_id"]) == "COMPLETED"


def test_concurrent_insert_race_maps_to_in_progress(
    db: PgUrls, catalog: FixtureCatalog, monkeypatch: pytest.MonkeyPatch
) -> None:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    winner = request(db, view)
    real_latest = service._latest
    calls: list[int] = []

    def blind_first_two(
        *args: Any, **kwargs: Any
    ) -> Any:  # the loser's pre-checks ran before the winner's commit
        calls.append(1)
        return None if len(calls) <= 2 else real_latest(*args, **kwargs)

    monkeypatch.setattr(service, "_latest", blind_first_two)
    loser = request(db, view)
    assert (loser.kind, loser.row["validation_id"]) == ("IN_PROGRESS", winner.row["validation_id"])


def test_public_port_reports_latest_completed_overall(db: PgUrls, catalog: FixtureCatalog) -> None:
    wire()
    port = ports.get(ReadinessQueryPort)
    view = catalog.add_fixture("invalid_units", owner_organization_id=ORG_B)
    outcome = request(db, view, "GENERIC_BASIC")
    assert port.get_latest_overall(view.dataset_version_id, "GENERIC_BASIC") is None
    jobs.run_validation(outcome.row["validation_id"])
    assert port.get_latest_overall(view.dataset_version_id, "GENERIC_BASIC") == "WARNING"
    assert port.get_latest_overall(uuid.uuid4(), "GENERIC_BASIC") is None


def test_broker_outage_at_enqueue_keeps_the_committed_row(
    db: PgUrls, catalog: FixtureCatalog, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Review focus: Redis down after commit -> the request still succeeds; the row waits for the sweeper."""

    def boom(*_: Any, **__: Any) -> None:
        raise ConnectionError("redis down")

    monkeypatch.setattr(jobs.run_validation_actor, "send_with_options", boom)
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    outcome = request(db, view)
    assert outcome.kind == "QUEUED"
    assert row(db, outcome.row["validation_id"])["run_status"] == "QUEUED"


def test_conflict_with_winner_completed_meanwhile_is_reused(
    db: PgUrls, catalog: FixtureCatalog, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Pre-checks blind, insert hits uq_validation_inflight, the winner COMPLETES before the re-read -> REUSED."""
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    winner = request(db, view, "GENERIC_BASIC")
    real_latest = service._latest
    calls: list[int] = []

    def blind_then_complete(*args: Any, **kwargs: Any) -> Any:
        calls.append(1)
        if len(calls) <= 2:
            return None
        if len(calls) == 3:  # first re-read after the conflict: the winner finishes just before it
            jobs.run_validation(winner.row["validation_id"])
        return real_latest(*args, **kwargs)

    monkeypatch.setattr(service, "_latest", blind_then_complete)
    loser = request(db, view, "GENERIC_BASIC")
    assert (loser.kind, loser.row["validation_id"]) == ("REUSED", winner.row["validation_id"])
    assert len(queued_messages()) == 1


def test_two_sessions_block_on_unique_index_then_in_progress(db: PgUrls, catalog: FixtureCatalog) -> None:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    profile = PROFILES["GENERIC_BASIC"]
    result: dict[str, Any] = {}
    started = threading.Event()

    def second() -> None:
        started.set()
        try:
            result["outcome"] = request(db, view, "GENERIC_BASIC")
        except Exception as exc:  # surface the cause in the assertion below
            result["error"] = exc

    with session_factory(db.app)() as a, a.begin():
        first = request_validation(
            a, view, profile, triggered_by="AUTO_ON_PUBLISH", requester=None, correlation_id=CORRELATION
        )
        assert first.kind == "QUEUED"
        thread = threading.Thread(target=second, daemon=True)
        thread.start()
        started.wait(5)
        thread.join(1.0)
        assert thread.is_alive(), "B should block on the uncommitted in-flight row"
        # A committed here
    thread.join(10)
    assert not thread.is_alive()
    assert "error" not in result, result.get("error")
    outcome = result["outcome"]
    assert (outcome.kind, outcome.row["validation_id"]) == ("IN_PROGRESS", first.row["validation_id"])
    assert len(queued_messages()) == 1


def test_public_module_is_a_leaf() -> None:
    """D-038: public.py imports only stdlib/typing; run it standalone so the package __init__ (actor) is not involved."""
    path = Path(__file__).parents[1] / "public.py"
    tree = ast.parse(path.read_text())
    imported = {
        (node.module or "") if isinstance(node, ast.ImportFrom) else alias.name
        for node in ast.walk(tree)
        if isinstance(node, (ast.Import, ast.ImportFrom))
        for alias in (node.names if isinstance(node, ast.Import) else [None])
    }
    assert imported <= {"typing", "uuid"}, imported
    code = (
        "import runpy, sys;"
        f"runpy.run_path({str(path)!r});"
        "sys.exit(1 if any(m in sys.modules for m in ('api.modules.readiness.jobs', 'pyarrow')) else 0)"
    )
    assert subprocess.run([sys.executable, "-c", code], check=False).returncode == 0
