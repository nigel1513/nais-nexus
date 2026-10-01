import uuid
from datetime import UTC, datetime, timedelta

import pytest
from dramatiq.brokers.stub import StubBroker
from sqlalchemy import text

from api.modules.audit import MODULE, email_queue, jobs
from api.modules.audit.email import max_lease_ms
from api.modules.audit.handlers import notifier
from api.modules.audit.jobs import SEND_ACTOR_NAME, purge_notifications, register_worker
from api.modules.audit.settings import AuditSettings
from api.modules.audit.tests.support.db import run, scalar
from api.modules.audit.tests.support.events import envelope
from api.platform.db import session_factory
from api.platform.scheduler import Scheduler
from api.platform.settings import Settings
from api.platform.testing.fixtures import PgUrls
from api.worker import build_worker

NOW = datetime(2026, 10, 1, tzinfo=UTC)


def test_register_worker_declares_actor_and_jobs() -> None:
    broker, scheduler = StubBroker(), Scheduler()
    try:
        register_worker(broker, scheduler)
        assert SEND_ACTOR_NAME in broker.get_declared_actors()
        assert scheduler.job_names == ["audit.send_emails", "audit.purge_notifications"]
        options = broker.get_actor(SEND_ACTOR_NAME).options
        assert options["max_retries"] == 0
        assert options["time_limit"] == max_lease_ms(AuditSettings())  # 50 * (10s * 6) + 60s
        assert broker.get_actor(SEND_ACTOR_NAME).queue_name == "audit"
    finally:
        email_queue.set_send_actor(None)


def test_build_worker_includes_audit_jobs() -> None:
    try:
        runtime = build_worker(modules=[MODULE], broker=StubBroker(), settings=Settings())
        assert {"audit.send_emails", "audit.purge_notifications"} <= set(runtime.scheduler.job_names)
    finally:
        email_queue.set_send_actor(None)


def test_notifier_commit_enqueues_actor_message(db: PgUrls) -> None:
    broker = StubBroker()
    try:
        register_worker(broker, Scheduler())
        run(db, notifier, envelope("project.member.added.v1"))
        assert broker.queues["audit"].qsize() == 1
    finally:
        email_queue.set_send_actor(None)


def _notification(db: PgUrls, *, created_at: datetime, read: bool) -> uuid.UUID:
    nid = uuid.uuid4()
    with session_factory(db.app)() as s, s.begin():
        s.execute(
            text(
                "INSERT INTO audit.notifications (notification_id, recipient_user_id, type, title, link, "
                "source_event_id, read_at, created_at) VALUES (:n, :r, 'ACCESS_REVOKED', 't', '/x', :s, :read_at, :c)"
            ),
            {
                "n": nid,
                "r": uuid.uuid4(),
                "s": uuid.uuid4(),
                "read_at": created_at if read else None,
                "c": created_at,
            },
        )
        s.execute(
            text(
                "INSERT INTO audit.email_deliveries (email_delivery_id, notification_id, to_address, status) "
                "VALUES (:e, :n, 'x@y', 'SENT')"
            ),
            {"e": uuid.uuid4(), "n": nid},
        )
    return nid


def test_purge_deletes_only_old_read_notifications_and_their_emails(db: PgUrls) -> None:
    old = NOW - timedelta(days=181)
    old_read = _notification(db, created_at=old, read=True)
    old_unread = _notification(db, created_at=old, read=False)
    recent_read = _notification(db, created_at=NOW - timedelta(days=10), read=True)
    deleted = purge_notifications(session_factory(db.app), AuditSettings(), now=lambda: NOW)
    assert deleted == 1
    ids = set(scalar(db, "SELECT array_agg(notification_id) FROM audit.notifications"))
    assert ids == {old_unread, recent_read}
    assert old_read not in ids
    assert scalar(db, "SELECT count(*) FROM audit.email_deliveries") == 2


def test_purge_runs_in_bounded_batches_and_leaves_audit_events(db: PgUrls) -> None:
    old = NOW - timedelta(days=200)
    for _ in range(5):
        _notification(db, created_at=old, read=True)
    before = scalar(db, "SELECT count(*) FROM audit.audit_events")
    deleted = purge_notifications(session_factory(db.app), AuditSettings(), now=lambda: NOW, batch_size=2)
    assert deleted == 5
    assert scalar(db, "SELECT count(*) FROM audit.notifications") == 0
    assert scalar(db, "SELECT count(*) FROM audit.audit_events") == before


def test_purge_job_failure_is_isolated_by_scheduler() -> None:
    scheduler = Scheduler(clock=lambda: 0.0)
    ran: list[str] = []

    def boom() -> None:
        raise RuntimeError("x")

    scheduler.every(1, "a", boom, run_immediately=True)
    scheduler.every(1, "b", lambda: ran.append("b"), run_immediately=True)
    assert scheduler.run_pending() == ["a", "b"]
    assert ran == ["b"]


def test_purge_runs_on_first_scheduler_tick(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(jobs, "_purge_job", lambda: None)
    broker, scheduler = StubBroker(), Scheduler()
    try:
        register_worker(broker, scheduler)
        assert scheduler.run_pending() == ["audit.purge_notifications"]  # send scan waits its 300 s interval
    finally:
        email_queue.set_send_actor(None)
