"""Run state machine (M05 §5), events (§7), retries (M05-AT-10), sweeper and worker wiring (§10)."""

import json
import threading
import uuid
from dataclasses import replace
from datetime import timedelta
from typing import Any

import pytest
from dramatiq.brokers.stub import StubBroker
from dramatiq.middleware import TimeLimitExceeded
from sqlalchemy import select, text, update
from sqlalchemy.exc import OperationalError

from api.modules.readiness import jobs
from api.modules.readiness.catalog_port import StorageUnavailable, VersionView
from api.modules.readiness.engine import VALIDATOR_VERSION
from api.modules.readiness.engine.canonical import (
    EVIDENCE_MAX_BYTES,
    bound_evidence,
    canonical_json,
    input_fingerprint,
)
from api.modules.readiness.engine.evaluate import CheckResult, ValidationResult, summarize
from api.modules.readiness.engine.parsing import FileTimeout, FileTooLarge
from api.modules.readiness.fakes import FIXTURES_ROOT, FixtureCatalog
from api.modules.readiness.tables import check_results, validations
from api.modules.readiness.tests.dbutil import CORRELATION, drain_jobs, events, queued_messages, row
from api.modules.readiness.tests.helpers import ORG_B, USERS
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.db import session_factory
from api.platform.scheduler import Scheduler
from api.platform.testing.fixtures import PgUrls


def insert_queued(
    db: PgUrls, view: VersionView, profile_id: str = "TABULAR_ML_BASIC", requester: CurrentUser | None = None
) -> uuid.UUID:
    """A QUEUED row + its Dramatiq message (sent after commit), as the service would create it."""
    assert view.manifest_sha256 is not None and view.metadata_snapshot is not None
    with session_factory(db.app)() as session, session.begin():
        validation_id = session.execute(
            validations.insert()
            .values(
                validation_id=uuid.uuid4(),
                dataset_version_id=view.dataset_version_id,
                dataset_id=view.dataset_id,
                owner_organization_id=view.owner_organization_id,
                profile_id=profile_id,
                profile_version="1.0.0",
                validator_version=VALIDATOR_VERSION,
                input_fingerprint=input_fingerprint(
                    view.manifest_sha256, view.metadata_snapshot, profile_id, "1.0.0", VALIDATOR_VERSION
                ),
                run_status="QUEUED",
                triggered_by="USER" if requester else "AUTO_ON_PUBLISH",
                requested_by=requester.user_id if requester else None,
                requester_organization_id=requester.organization_id if requester else None,
                attempt=0,
                correlation_id=CORRELATION,
            )
            .returning(validations.c.validation_id)
        ).scalar_one()
        jobs.enqueue_after_commit(session, validation_id, CORRELATION)
    return validation_id  # type: ignore[no-any-return]


# ---------------------------------------------------------------- enqueue after commit


def test_message_is_sent_after_commit_with_correlation_id(db: PgUrls, catalog: FixtureCatalog) -> None:
    vid = insert_queued(db, catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B))
    [message] = queued_messages()
    assert message["actor_name"] == "readiness.run_validation"
    assert message["args"] == [str(vid)]
    assert message["options"]["correlation_id"] == str(CORRELATION)


def test_rolled_back_transaction_sends_nothing(db: PgUrls) -> None:
    with session_factory(db.app)() as session:
        session.begin()
        jobs.enqueue_after_commit(session, uuid.uuid4(), CORRELATION)
        session.rollback()
        session.begin()
        session.commit()  # a later commit on the same session must not resurrect the dropped message
    assert queued_messages() == []


# ---------------------------------------------------------------- run


def test_run_completes_with_golden_result_and_events(db: PgUrls, catalog: FixtureCatalog) -> None:
    vid = insert_queued(db, catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B))
    assert jobs.run_validation(vid) == "COMPLETED"
    stored = row(db, vid)
    golden = json.loads((FIXTURES_ROOT / "clean_tabular/expected/TABULAR_ML_BASIC.json").read_text())
    assert (stored["run_status"], stored["overall_status"], stored["attempt"]) == ("COMPLETED", "PASS", 1)
    assert stored["result_sha256"] == golden["result_sha256"]
    assert stored["summary"] == {"pass": 9, "warning": 0, "fail": 0, "not_applicable": 0}
    assert stored["started_at"] is not None and stored["completed_at"] is not None
    with session_factory(db.app)() as session:
        query = select(check_results.c.ordinal).where(check_results.c.validation_id == vid)
        assert sorted(session.execute(query).scalars()) == list(range(1, 10))
    started, completed = events(db)
    assert started["event_type"] == "readiness.validation.started.v1"
    assert started["actor"] == {"type": "SYSTEM", "user_id": None, "organization_id": None}
    assert completed["event_type"] == "readiness.validation.completed.v1"
    assert completed["actor"]["type"] == "SYSTEM"
    assert completed["payload"]["run_status"] == "COMPLETED"
    assert completed["payload"]["owner_organization_id"] == str(ORG_B)
    assert completed["payload"]["input_fingerprint"] == stored["input_fingerprint"]
    assert {started["correlation_id"], completed["correlation_id"]} == {str(CORRELATION)}


def test_duplicate_delivery_is_skipped(db: PgUrls, catalog: FixtureCatalog) -> None:
    vid = insert_queued(
        db, catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B), "GENERIC_BASIC"
    )
    assert jobs.run_validation(vid) == "COMPLETED"
    assert jobs.run_validation(vid) == "SKIPPED"
    assert len(events(db)) == 2


def test_storage_outage_retries_twice_then_fails(db: PgUrls, catalog: FixtureCatalog) -> None:
    """M05-AT-10 (the recovery half is in test_service.py)."""
    vid = insert_queued(db, catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B))
    catalog.fail_reads = StorageUnavailable("connection refused")
    for attempt in (1, 2):
        with pytest.raises(jobs.RetryableInfraError):
            jobs.run_validation(vid)
        assert (row(db, vid)["run_status"], row(db, vid)["attempt"]) == ("QUEUED", attempt)
    assert jobs.run_validation(vid) == "FAILED"
    failed = row(db, vid)
    assert (failed["run_status"], failed["overall_status"], failed["attempt"]) == ("FAILED", None, 3)
    assert failed["error"] == "STORAGE_UNAVAILABLE: StorageUnavailable after 3 attempts"
    completed = [e for e in events(db) if e["event_type"] == "readiness.validation.completed.v1"]
    assert [e["payload"]["run_status"] for e in completed] == ["FAILED"]
    assert completed[0]["payload"]["overall_status"] is None
    assert completed[0]["payload"]["summary"] == {"pass": 0, "warning": 0, "fail": 0, "not_applicable": 0}


def test_retry_policy_only_retries_infra_errors() -> None:
    assert jobs._retry_when(0, jobs.RetryableInfraError())
    assert jobs._retry_when(1, jobs.RetryableInfraError())
    assert not jobs._retry_when(2, jobs.RetryableInfraError())
    assert not jobs._retry_when(0, ValueError())


def test_missing_object_fails_the_run(db: PgUrls, catalog: FixtureCatalog) -> None:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    vid = insert_queued(db, view)
    catalog.delete_object(view.dataset_version_id, "data/measurements.csv")
    assert jobs.run_validation(vid) == "FAILED"
    assert row(db, vid)["error"] == "FILE_NOT_FOUND: data/measurements.csv is missing in storage"


def test_unknown_version_fails_the_run(db: PgUrls, catalog: FixtureCatalog) -> None:
    view = FixtureCatalog().add_fixture("clean_tabular", owner_organization_id=ORG_B)  # not in `catalog`
    vid = insert_queued(db, view)
    assert jobs.run_validation(vid) == "FAILED"
    assert row(db, vid)["error"].startswith("VERSION_NOT_FOUND")


def test_file_timeout_and_crash_fail_without_data_values(
    db: PgUrls, catalog: FixtureCatalog, monkeypatch: pytest.MonkeyPatch
) -> None:
    def timeout(*_: Any, **__: Any) -> Any:
        raise FileTimeout()

    def crash(*_: Any, **__: Any) -> Any:
        raise KeyError("S0001")

    monkeypatch.setattr(jobs, "evaluate", timeout)
    vid = insert_queued(db, catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B))
    jobs.run_validation(vid)
    assert row(db, vid)["error"] == "FILE_TIMEOUT: parsing exceeded 600s"
    monkeypatch.setattr(jobs, "evaluate", crash)
    vid = insert_queued(db, catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B))
    jobs.run_validation(vid)
    assert row(db, vid)["error"] == "INTERNAL_ERROR: KeyError"


def test_worker_runs_user_request_with_user_actor(db: PgUrls, catalog: FixtureCatalog) -> None:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    vid = insert_queued(db, view, "GENERIC_BASIC", requester=USERS["b_steward"])
    drain_jobs()
    assert row(db, vid)["run_status"] == "COMPLETED"
    completed = events(db)[-1]
    assert completed["actor"] == {
        "type": "USER",
        "user_id": str(USERS["b_steward"].user_id),
        "organization_id": str(USERS["b_steward"].organization_id),
    }
    assert completed["correlation_id"] == str(CORRELATION)


# ---------------------------------------------------------------- sweeper and wiring


def test_sweeper_fails_stale_queued_jobs_only(db: PgUrls, catalog: FixtureCatalog) -> None:
    stale = insert_queued(
        db, catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B), "GENERIC_BASIC"
    )
    fresh = insert_queued(
        db, catalog.add_fixture("invalid_units", owner_organization_id=ORG_B), "GENERIC_BASIC"
    )
    with session_factory(db.app)() as session, session.begin():
        session.execute(
            update(validations)
            .where(validations.c.validation_id == stale)
            .values(created_at=text("now() - interval '61 minutes'"))
        )
    assert jobs.sweep_stale() == 1
    assert row(db, stale)["error"] == "STALE_JOB: no progress within the allowed time"
    assert row(db, fresh)["run_status"] == "QUEUED"
    assert events(db)[-1]["payload"]["run_status"] == "FAILED"


def test_sweeper_fails_runs_stuck_in_running(db: PgUrls, catalog: FixtureCatalog) -> None:
    vid = insert_queued(
        db, catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B), "GENERIC_BASIC"
    )
    with clock.frozen(clock.now() - timedelta(seconds=jobs._SETTINGS.run_timeout_seconds, minutes=11)):
        jobs.start_run(vid)
    assert jobs.sweep_stale() == 1
    assert row(db, vid)["run_status"] == "FAILED"


def test_register_worker_adds_sweeper_and_checks_broker() -> None:
    scheduler = Scheduler()
    jobs.register_worker(jobs.run_validation_actor.broker, scheduler)
    assert scheduler.job_names == ["readiness.sweep_stale"]
    assert jobs.run_validation_actor.queue_name == "readiness"
    with pytest.raises(RuntimeError, match="broker"):
        jobs.register_worker(StubBroker(), Scheduler())


def test_evidence_at_the_64_kib_bound_is_stored(db: PgUrls, catalog: FixtureCatalog) -> None:
    """Review focus: canonical evidence <= 64 KiB must fit the DB check (jsonb text adds spaces)."""
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    vid = insert_queued(db, view, "GENERIC_BASIC")
    jobs.start_run(vid)
    entries = [{"path": "data/x.csv", "field": f"f{i:05d}", "missing": 1, "ratio": 0.1} for i in range(1030)]
    evidence = bound_evidence({"fields": entries})
    assert "truncated" not in evidence
    assert 64_000 < len(canonical_json(evidence).encode()) <= EVIDENCE_MAX_BYTES  # jsonb::text is ~73 KB
    check = CheckResult("metadata.completeness", 1, "REQUIRED", "PASS", "m", evidence)
    result = ValidationResult(
        "GENERIC_BASIC", "1.0.0", VALIDATOR_VERSION, "PASS", summarize([check]), (check,), "0" * 64
    )
    assert jobs._complete(vid, result) is True
    assert row(db, vid)["run_status"] == "COMPLETED"


# ---------------------------------------------------------------- Task 12 carries


def _simple_result() -> ValidationResult:
    check = CheckResult("metadata.completeness", 1, "REQUIRED", "PASS", "m", {})
    return ValidationResult(
        "GENERIC_BASIC", "1.0.0", VALIDATOR_VERSION, "PASS", summarize([check]), (check,), "0" * 64
    )


def test_file_too_large_fails_the_run(
    db: PgUrls, catalog: FixtureCatalog, monkeypatch: pytest.MonkeyPatch
) -> None:
    def too_large(*_: Any, **__: Any) -> Any:
        raise FileTooLarge()

    monkeypatch.setattr(jobs, "evaluate", too_large)
    vid = insert_queued(db, catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B))
    assert jobs.run_validation(vid) == "FAILED"
    failed = row(db, vid)
    assert failed["error"] == "FILE_TOO_LARGE: a file exceeds the validation size limit"
    assert failed["overall_status"] is None


def test_withdrawn_version_is_not_validated(db: PgUrls, catalog: FixtureCatalog) -> None:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    vid = insert_queued(db, view)
    catalog.replace_view(replace(view, status="WITHDRAWN"))
    assert jobs.run_validation(vid) == "FAILED"
    assert row(db, vid)["error"].startswith("VERSION_NOT_FOUND")


def test_partial_results_are_replaced_and_completed_rows_are_never_touched(
    db: PgUrls, catalog: FixtureCatalog
) -> None:
    vid = insert_queued(
        db, catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B), "GENERIC_BASIC"
    )
    jobs.start_run(vid)
    with session_factory(db.app)() as session, session.begin():  # leftovers of an interrupted attempt
        session.execute(
            check_results.insert().values(
                validation_id=vid,
                check_id="stale.check",
                ordinal=7,
                severity="REQUIRED",
                status="PASS",
                message="x",
                evidence={},
            )
        )
    result = _simple_result()
    assert jobs._complete(vid, result) is True
    with session_factory(db.app)() as session:
        query = select(check_results.c.check_id).where(check_results.c.validation_id == vid)
        assert list(session.execute(query).scalars()) == ["metadata.completeness"]
    assert jobs._complete(vid, result) is False  # COMPLETED: no write, no trigger error
    assert jobs.fail_run(vid, "X: late") is False
    assert row(db, vid)["run_status"] == "COMPLETED"
    assert len(events(db)) == 2


def test_failed_run_is_never_reopened(db: PgUrls, catalog: FixtureCatalog) -> None:
    vid = insert_queued(db, catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B))
    jobs.start_run(vid)
    assert jobs.fail_run(vid, "X: boom") is True
    assert jobs.start_run(vid) is None
    assert jobs._complete(vid, _simple_result()) is False
    assert jobs.run_validation(vid) == "SKIPPED"
    assert row(db, vid)["run_status"] == "FAILED"


def test_sweeper_does_not_fail_a_run_a_worker_just_started(db: PgUrls, catalog: FixtureCatalog) -> None:
    vid = insert_queued(
        db, catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B), "GENERIC_BASIC"
    )
    with session_factory(db.app)() as session, session.begin():
        session.execute(
            update(validations)
            .where(validations.c.validation_id == vid)
            .values(created_at=text("now() - interval '61 minutes'"))
        )
    assert jobs._stale_ids(clock.now()) == [vid]  # the sweeper sees it stale...
    jobs.start_run(vid)  # ...but a live worker claims it before the guarded update
    assert jobs._fail_if_stale(vid, clock.now()) is False
    assert row(db, vid)["run_status"] == "RUNNING"


def test_evaluation_holds_no_transaction(
    db: PgUrls, catalog: FixtureCatalog, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Claim is committed before evaluate runs: another connection sees RUNNING and no locks are held."""
    vid = insert_queued(db, catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B))
    seen: dict[str, Any] = {}
    real = jobs.evaluate

    def spy(*args: Any, **kwargs: Any) -> Any:
        seen["status"] = row(db, vid)["run_status"]
        with session_factory(db.app)() as session:
            seen["idle_in_tx"] = session.execute(
                text(
                    "SELECT count(*) FROM pg_stat_activity WHERE state LIKE 'idle in transaction%' "
                    "AND datname = current_database()"
                )
            ).scalar_one()
        return real(*args, **kwargs)

    monkeypatch.setattr(jobs, "evaluate", spy)
    assert jobs.run_validation(vid) == "COMPLETED"
    assert seen == {"status": "RUNNING", "idle_in_tx": 0}


# ---------------------------------------------------------------- fix round 1 (M05-R16)


def _db_down(*_: Any, **__: Any) -> Any:
    raise OperationalError("SELECT 1", {}, Exception("connection refused"))


def test_db_outage_at_claim_is_retryable_and_leaves_the_row_queued(
    db: PgUrls, catalog: FixtureCatalog, monkeypatch: pytest.MonkeyPatch
) -> None:
    vid = insert_queued(db, catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B))
    with monkeypatch.context() as m:
        m.setattr(jobs, "_session", _db_down)
        with pytest.raises(jobs.RetryableInfraError):
            jobs.run_validation(vid)
    assert row(db, vid)["run_status"] == "QUEUED"
    assert jobs.run_validation(vid) == "COMPLETED"  # the redelivery succeeds once the DB is back


def test_db_outage_while_recovering_is_retryable_not_a_crash(
    db: PgUrls, catalog: FixtureCatalog, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(jobs, "DB_RETRY_DELAY_S", 0)
    vid = insert_queued(db, catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B))

    def storage_then_db_down(*_: Any, **__: Any) -> Any:
        monkeypatch.setattr(jobs, "_session", _db_down)  # the DB dies right after the claim committed
        raise StorageUnavailable("x")

    monkeypatch.setattr(jobs, "evaluate", storage_then_db_down)
    with pytest.raises(jobs.RetryableInfraError):  # from _requeue, not a bare OperationalError
        jobs.run_validation(vid)


def test_db_outage_while_failing_is_retryable(
    db: PgUrls, catalog: FixtureCatalog, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(jobs, "DB_RETRY_DELAY_S", 0)
    vid = insert_queued(db, catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B))

    def crash_then_db_down(*_: Any, **__: Any) -> Any:
        monkeypatch.setattr(jobs, "_session", _db_down)
        raise FileTimeout()

    monkeypatch.setattr(jobs, "evaluate", crash_then_db_down)
    with pytest.raises(jobs.RetryableInfraError):
        jobs.run_validation(vid)


def test_reuse_conflict_fails_the_run_with_a_clear_reason(db: PgUrls, catalog: FixtureCatalog) -> None:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    first = insert_queued(db, view, "GENERIC_BASIC")
    assert jobs.run_validation(first) == "COMPLETED"
    # a concurrent identical run that was claimed before `first` completed: same fingerprint, now RUNNING
    with session_factory(db.app)() as session, session.begin():
        fp = row(db, first)["input_fingerprint"]
        second = session.execute(
            validations.insert()
            .values(
                validation_id=uuid.uuid4(),
                dataset_version_id=view.dataset_version_id,
                dataset_id=view.dataset_id,
                owner_organization_id=view.owner_organization_id,
                profile_id="GENERIC_BASIC",
                profile_version="1.0.0",
                validator_version=VALIDATOR_VERSION,
                input_fingerprint=fp,
                run_status="RUNNING",
                triggered_by="AUTO_ON_PUBLISH",
                attempt=1,
                correlation_id=CORRELATION,
            )
            .returning(validations.c.validation_id)
        ).scalar_one()
    assert jobs.run_validation(second) == "SKIPPED"  # not QUEUED: nothing to do
    # drive the conflict itself: evaluate for the RUNNING row
    result = jobs.evaluate(
        catalog.get_version(view.dataset_version_id),  # type: ignore[arg-type]
        jobs.PROFILES["GENERIC_BASIC"],
        catalog,
        file_timeout_s=60,
    )
    with pytest.raises(jobs._ReuseConflict):
        jobs._complete(second, result)
    assert row(db, second)["run_status"] == "RUNNING"  # nothing half-written
    assert jobs._fail(second, "INTERNAL_ERROR: reuse conflict") == "FAILED"
    assert row(db, first)["run_status"] == "COMPLETED"


def test_failed_return_value_is_accurate_when_nothing_was_failed(
    db: PgUrls, catalog: FixtureCatalog, monkeypatch: pytest.MonkeyPatch
) -> None:
    def sweep_then_timeout(*_: Any, **__: Any) -> Any:
        jobs.fail_run(vid, "STALE_JOB: swept meanwhile")
        raise FileTimeout()

    vid = insert_queued(db, catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B))
    monkeypatch.setattr(jobs, "evaluate", sweep_then_timeout)
    assert jobs.run_validation(vid) == "SKIPPED"
    assert row(db, vid)["error"].startswith("STALE_JOB")


def test_two_workers_claim_exactly_once(db: PgUrls, catalog: FixtureCatalog) -> None:
    vid = insert_queued(db, catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B))
    barrier = threading.Barrier(2)
    results: list[Any] = []

    def claim() -> None:
        barrier.wait()
        results.append(jobs.start_run(vid))

    threads = [threading.Thread(target=claim) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(r is None for r in results) == [False, True]
    assert [e["event_type"] for e in events(db)] == ["readiness.validation.started.v1"]
    assert row(db, vid)["attempt"] == 1


def test_time_limit_fails_the_run_with_run_timeout(
    db: PgUrls, catalog: FixtureCatalog, monkeypatch: pytest.MonkeyPatch
) -> None:
    def too_slow(*_: Any, **__: Any) -> Any:
        raise TimeLimitExceeded()

    monkeypatch.setattr(jobs, "evaluate", too_slow)
    vid = insert_queued(db, catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B))
    jobs.run_validation_actor.fn(str(vid))
    assert row(db, vid)["error"] == f"RUN_TIMEOUT: exceeded {jobs._SETTINGS.run_timeout_seconds}s"
    assert events(db)[-1]["payload"]["run_status"] == "FAILED"
