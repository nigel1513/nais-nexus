from datetime import UTC, datetime, timedelta

from dramatiq.brokers.stub import StubBroker
from sqlalchemy import text

from api.modules.identity import MODULE
from api.modules.identity.jobs import prune_sessions, register_worker, run_prune_sessions
from api.modules.identity.seed_data import USERS_BY_EMAIL
from api.modules.identity.tests.support import scalar
from api.platform import clock
from api.platform.db import session_scope
from api.platform.scheduler import Scheduler
from api.platform.testing.fixtures import PgUrls

NOW = datetime(2026, 10, 1, tzinfo=UTC)


def add_session(urls: PgUrls, session_id: str, age: timedelta) -> None:
    with session_scope(urls.app) as session:
        session.execute(
            text(
                "INSERT INTO identity.user_sessions (session_id, user_id, first_seen_at) VALUES (:s, :u, :t)"
            ),
            {"s": session_id, "u": USERS_BY_EMAIL["a.researcher@inst-a.local"].user_id, "t": NOW - age},
        )


def test_prune_deletes_sessions_older_than_90_days(seeded: PgUrls) -> None:
    add_session(seeded, "old", timedelta(days=91))
    add_session(seeded, "recent", timedelta(days=89))
    with session_scope(seeded.app) as session:
        assert prune_sessions(session, now=NOW) == 1
    assert scalar(seeded, "SELECT array_agg(session_id) FROM identity.user_sessions") == ["recent"]


def test_scheduled_run_uses_the_clock(seeded: PgUrls) -> None:
    add_session(seeded, "old", timedelta(days=91))
    with clock.frozen(NOW):
        run_prune_sessions(lambda: session_scope(seeded.app))
    assert scalar(seeded, "SELECT count(*) FROM identity.user_sessions") == 0


def test_job_is_registered_daily() -> None:
    scheduler = Scheduler(clock=lambda: 0.0)
    register_worker(StubBroker(), scheduler)
    assert scheduler.job_names == ["identity.prune_sessions"]
    (job,) = scheduler._jobs
    assert job.interval_s == 86400
    assert job.next_run == 0.0  # run_immediately=True: due on the first tick
    assert MODULE.register_worker is register_worker
