from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage

import pytest
from sqlalchemy import text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from api.modules.audit.email import (
    MAX_ATTEMPTS,
    SendResult,
    SmtpEmailSender,
    build_message,
    send_pending_emails,
)
from api.modules.audit.handlers import notifier
from api.modules.audit.settings import AuditSettings
from api.modules.audit.tests.support.db import fetch, run, scalar
from api.modules.audit.tests.support.events import envelope
from api.platform.db import session_factory
from api.platform.testing.fixtures import PgUrls

SETTINGS = AuditSettings(nais_public_base_url="http://localhost:21051")


class FakeSender:
    def __init__(self) -> None:
        self.sent: list[EmailMessage] = []
        self.down = False

    def send(self, message: EmailMessage) -> None:
        if self.down:
            raise ConnectionRefusedError("smtp down")
        self.sent.append(message)


def _send(db: PgUrls, sender: FakeSender, at: datetime) -> SendResult:
    return send_pending_emails(session_factory(db.app), sender, SETTINGS, now=lambda: at)


def test_build_message_contains_title_body_and_absolute_link() -> None:
    msg = build_message(
        to_address="b.researcher@inst-b.local",
        title="제목",
        body="본문",
        link="/commons/projects/x",
        settings=SETTINGS,
    )
    assert msg["From"] == "NAIS AI-OS <no-reply@nais.local>"
    assert msg["To"] == "b.researcher@inst-b.local"
    assert msg["Subject"] == "제목"
    content = msg.get_content()
    assert "본문" in content and "http://localhost:21051/commons/projects/x" in content


def test_pending_email_is_sent(db: PgUrls) -> None:  # M09-AT-09 (mail half, fake SMTP)
    run(db, notifier, envelope("project.member.added.v1"))
    sender = FakeSender()
    at = datetime.now(UTC) + timedelta(seconds=5)  # rows are due from DB now(); never use a fixed past time
    assert _send(db, sender, at) == SendResult(sent=1, retried=0, failed=0)
    [msg] = sender.sent
    assert msg["To"] == "b.researcher@inst-b.local"
    assert "프로젝트에 참여자로 추가되었습니다" in msg["Subject"]
    [row] = fetch(db, "SELECT status, attempts, sent_at FROM audit.email_deliveries")
    assert (row["status"], row["attempts"]) == ("SENT", 1) and row["sent_at"] is not None
    assert _send(db, sender, at + timedelta(hours=1)) == SendResult(0, 0, 0)  # not resent


def test_smtp_down_keeps_in_app_and_retries_after_recovery(db: PgUrls) -> None:  # M09-AT-14
    run(db, notifier, envelope("project.member.added.v1"))
    sender = FakeSender()
    sender.down = True
    start = datetime.now(UTC) + timedelta(seconds=5)
    assert _send(db, sender, start) == SendResult(sent=0, retried=1, failed=0)
    [row] = fetch(db, "SELECT status, attempts, next_attempt_at, last_error FROM audit.email_deliveries")
    assert (row["status"], row["attempts"]) == ("PENDING", 1)
    assert row["next_attempt_at"] == start + timedelta(minutes=1)
    assert "smtp down" in row["last_error"]
    assert scalar(db, "SELECT count(*) FROM audit.notifications") == 1  # in-app unaffected
    sender.down = False
    assert _send(db, sender, start + timedelta(seconds=30)) == SendResult(0, 0, 0)  # not due yet
    assert _send(db, sender, start + timedelta(minutes=1)) == SendResult(sent=1, retried=0, failed=0)
    assert scalar(db, "SELECT status FROM audit.email_deliveries") == "SENT"


def test_fifth_failure_marks_failed_and_stops(db: PgUrls) -> None:  # Review Focus 4
    run(db, notifier, envelope("project.member.added.v1"))
    sender = FakeSender()
    sender.down = True
    at = datetime.now(UTC) + timedelta(seconds=5)
    waits = [timedelta(minutes=1), timedelta(minutes=5), timedelta(minutes=15), timedelta(hours=1)]
    for wait in waits:
        assert _send(db, sender, at).retried == 1
        at += wait
    assert _send(db, sender, at) == SendResult(sent=0, retried=0, failed=1)
    [row] = fetch(db, "SELECT status, attempts FROM audit.email_deliveries")
    assert (row["status"], row["attempts"]) == ("FAILED", MAX_ATTEMPTS)
    sender.down = False
    assert _send(db, sender, at + timedelta(days=1)) == SendResult(0, 0, 0)


def test_smtp_sender_raises_when_server_unreachable() -> None:
    msg = build_message(to_address="x@y", title="t", body="", link="/", settings=SETTINGS)
    with pytest.raises(OSError):
        SmtpEmailSender("127.0.0.1", 1, 1.0).send(msg)


class ReentrantSender(FakeSender):
    """Simulates a second worker running while the first is inside the SMTP call."""

    def __init__(self, db: PgUrls, at: datetime) -> None:
        super().__init__()
        self.db, self.at = db, at
        self.inner: SendResult | None = None
        self.row_locked: bool | None = None

    def send(self, message: EmailMessage) -> None:
        if self.inner is None:
            self.inner = _send(self.db, FakeSender(), self.at)
            try:  # the claim must not hold a row lock across the network call
                scalar(
                    self.db,
                    "SELECT 1 FROM audit.email_deliveries FOR UPDATE NOWAIT",
                )
                self.row_locked = False
            except OperationalError:
                self.row_locked = True
        super().send(message)


def test_concurrent_worker_never_double_sends_and_holds_no_lock(db: PgUrls) -> None:  # M09-AT-14
    run(db, notifier, envelope("project.member.added.v1"))
    at = datetime.now(UTC) + timedelta(seconds=5)
    sender = ReentrantSender(db, at)
    assert _send(db, sender, at) == SendResult(sent=1, retried=0, failed=0)
    assert sender.inner == SendResult(0, 0, 0)
    assert sender.row_locked is False
    assert len(sender.sent) == 1
    assert scalar(db, "SELECT attempts FROM audit.email_deliveries") == 1


class Hook(FakeSender):
    def __init__(self, hook: Callable[[EmailMessage], None]) -> None:
        super().__init__()
        self.hook = hook

    def send(self, message: EmailMessage) -> None:
        self.hook(message)
        super().send(message)


def _budget_s() -> float:
    return SETTINGS.smtp_timeout_seconds * 6


def test_stale_outcome_is_dropped_and_not_counted(db: PgUrls) -> None:
    run(db, notifier, envelope("project.member.added.v1"))

    def bump(_: EmailMessage) -> None:
        with session_factory(db.app)() as s, s.begin():
            s.execute(text("UPDATE audit.email_deliveries SET attempts = attempts + 1"))

    at = datetime.now(UTC) + timedelta(seconds=5)
    assert _send(db, Hook(bump), at) == SendResult(0, 0, 0)
    [row] = fetch(db, "SELECT status, attempts FROM audit.email_deliveries")
    assert (row["status"], row["attempts"]) == ("PENDING", 2)


def test_lease_covers_budget_and_expires(db: PgUrls) -> None:
    run(db, notifier, envelope("project.member.added.v1"))
    at = datetime.now(UTC) + timedelta(seconds=5)
    seen: list[datetime] = []
    sender = Hook(lambda _: seen.append(scalar(db, "SELECT next_attempt_at FROM audit.email_deliveries")))
    sender.down = True
    assert _send(db, sender, at).retried == 1
    assert seen[0] >= at + timedelta(seconds=_budget_s() + 60)
    lease_end = seen[0]
    # a crashed worker leaves the lease behind: simulate by restoring it, then it is due again only after it
    run_sql(db, "UPDATE audit.email_deliveries SET next_attempt_at = :t", t=lease_end)
    ok = FakeSender()
    assert _send(db, ok, lease_end - timedelta(seconds=1)) == SendResult(0, 0, 0)
    assert _send(db, ok, lease_end) == SendResult(sent=1)


def run_sql(db: PgUrls, sql: str, **params: object) -> None:
    with session_factory(db.app)() as s, s.begin():
        s.execute(text(sql), params)


def test_unsent_claims_released_when_outcome_transaction_raises(db: PgUrls) -> None:
    for _ in range(3):
        run(db, notifier, envelope("project.member.added.v1"))
    assert scalar(db, "SELECT count(*) FROM audit.email_deliveries") == 3
    real = session_factory(db.app)
    calls = {"n": 0}

    def factory() -> Session:
        calls["n"] += 1
        if calls["n"] == 2:  # first outcome transaction
            raise RuntimeError("db gone")
        return real()

    at = datetime.now(UTC) + timedelta(seconds=5)
    with pytest.raises(RuntimeError):
        send_pending_emails(factory, FakeSender(), SETTINGS, now=lambda: at)
    rows = fetch(db, "SELECT attempts, next_attempt_at FROM audit.email_deliveries")
    assert sorted(r["attempts"] for r in rows) == [0, 0, 1]
    assert sum(1 for r in rows if r["next_attempt_at"] <= at) == 2


def test_batch_stops_and_releases_when_lease_runs_low(db: PgUrls) -> None:
    for _ in range(2):
        run(db, notifier, envelope("project.member.added.v1"))
    clock_at = [datetime.now(UTC) + timedelta(seconds=5)]

    def advance(_: EmailMessage) -> None:
        clock_at[0] += timedelta(seconds=_budget_s() + 61)

    sender = Hook(advance)
    result = send_pending_emails(session_factory(db.app), sender, SETTINGS, now=lambda: clock_at[0])
    assert result == SendResult(sent=1)
    assert sorted(r["attempts"] for r in fetch(db, "SELECT attempts FROM audit.email_deliveries")) == [0, 1]


def test_last_error_scrubs_address_case_insensitively_and_is_bounded(db: PgUrls) -> None:
    run(db, notifier, envelope("project.member.added.v1"))

    def boom(m: EmailMessage) -> None:
        raise RuntimeError(f"rejected {str(m['To']).upper()} " + "x" * 5000)

    at = datetime.now(UTC) + timedelta(seconds=5)
    assert _send(db, Hook(boom), at).retried == 1
    err = scalar(db, "SELECT last_error FROM audit.email_deliveries")
    assert "b.researcher@inst-b.local" not in err.lower()
    assert len(err) <= 2000


def test_wire_encoding_is_ascii_safe_for_korean() -> None:
    msg = build_message(to_address="x@y", title="제목", body="본문", link="/", settings=SETTINGS)
    raw = msg.as_bytes()
    assert raw.isascii()
    assert b"Subject: =?utf-8?" in raw
    assert b"Content-Transfer-Encoding: quoted-printable" in raw
