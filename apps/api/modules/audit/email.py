"""Email delivery (spec §5, §10): PENDING -> SENT | PENDING(+backoff) | FAILED after 5 attempts.

Concurrency: a row is claimed in a short transaction (FOR UPDATE SKIP LOCKED), its attempts are incremented and
next_attempt_at is pushed out by a lease, then the transaction commits. SMTP is called with no lock or transaction
open; a second worker skips leased rows. The outcome is written in a second short transaction. If a worker dies
mid-send the row becomes due again after the lease (at-least-once, and the attempt is already counted).
"""

import logging
import smtplib
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from email.message import EmailMessage
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from api.modules.audit.settings import AuditSettings, get_audit_settings
from api.modules.audit.tables import email_deliveries, notifications
from api.platform import clock
from api.platform.db import session_factory

logger = logging.getLogger("nais.audit")
BACKOFF: tuple[timedelta, ...] = (
    timedelta(minutes=1),
    timedelta(minutes=5),
    timedelta(minutes=15),
    timedelta(hours=1),
)
MAX_ATTEMPTS = 5
_LEASE_MARGIN = timedelta(seconds=60)


class EmailSender(Protocol):
    def send(self, message: EmailMessage) -> None: ...


class SmtpEmailSender:
    """Plain SMTP, no auth (dev: Mailpit on SMTP_HOST:SMTP_PORT = mailpit:1025)."""

    def __init__(self, host: str, port: int, timeout: float) -> None:
        self.host, self.port, self.timeout = host, port, timeout

    def send(self, message: EmailMessage) -> None:
        with smtplib.SMTP(self.host, self.port, timeout=self.timeout) as smtp:
            smtp.send_message(message)


@dataclass(frozen=True)
class SendResult:
    sent: int = 0
    retried: int = 0
    failed: int = 0


@dataclass(frozen=True)
class _Claimed:
    email_delivery_id: UUID
    to_address: str
    attempts: int
    title: str
    body: str
    link: str


def build_message(
    *, to_address: str, title: str, body: str, link: str, settings: AuditSettings
) -> EmailMessage:
    """Only title/body/link (never purpose_detail); the notification row never carries it."""
    message = EmailMessage()
    message["From"] = settings.smtp_from
    message["To"] = to_address
    message["Subject"] = title
    parts = [title, body, f"{settings.nais_public_base_url.rstrip('/')}{link}"]
    message.set_content("\n\n".join(p for p in parts if p))
    return message


def _claim(
    factory: Callable[[], Session], settings: AuditSettings, now: Callable[[], datetime], batch_size: int
) -> list[_Claimed]:
    e, n = email_deliveries.c, notifications.c
    with factory() as session, session.begin():
        rows = session.execute(
            select(e.email_delivery_id, e.to_address, e.attempts, n.title, n.body, n.link)
            .join(notifications, n.notification_id == e.notification_id)
            .where(e.status == "PENDING", e.next_attempt_at <= now())
            .order_by(e.next_attempt_at)
            .limit(batch_size)
            .with_for_update(of=email_deliveries, skip_locked=True)
        ).all()
        if not rows:
            return []
        lease = now() + timedelta(seconds=settings.smtp_timeout_seconds * len(rows)) + _LEASE_MARGIN
        for row in rows:
            session.execute(
                update(email_deliveries)
                .where(e.email_delivery_id == row.email_delivery_id)
                .values(attempts=row.attempts + 1, next_attempt_at=lease)
            )
        return [
            _Claimed(r.email_delivery_id, r.to_address, r.attempts + 1, r.title, r.body, r.link) for r in rows
        ]


def _describe(exc: Exception, to_address: str) -> str:
    return repr(exc).replace(to_address, "<recipient>")[:2000]


def send_pending_emails(
    factory: Callable[[], Session],
    sender: EmailSender,
    settings: AuditSettings,
    *,
    now: Callable[[], datetime] = clock.now,
    batch_size: int = 50,
) -> SendResult:
    sent = retried = failed = 0
    e = email_deliveries.c
    for row in _claim(factory, settings, now, batch_size):
        values: dict[str, Any]
        try:
            sender.send(
                build_message(
                    to_address=row.to_address,
                    title=row.title,
                    body=row.body,
                    link=row.link,
                    settings=settings,
                )
            )
        except Exception as exc:
            # Log the id and exception type only: SMTP errors can embed the recipient address.
            logger.warning(
                "email send failed",
                extra={"email_delivery_id": str(row.email_delivery_id), "error_type": type(exc).__name__},
            )
            values = {"last_error": _describe(exc, row.to_address)}
            if row.attempts >= MAX_ATTEMPTS:
                values["status"] = "FAILED"
                failed += 1
            else:
                values["next_attempt_at"] = now() + BACKOFF[row.attempts - 1]
                retried += 1
        else:
            values = {"status": "SENT", "sent_at": now(), "last_error": None}
            sent += 1
        with factory() as session, session.begin():
            session.execute(
                update(email_deliveries)
                .where(e.email_delivery_id == row.email_delivery_id, e.attempts == row.attempts)
                .values(**values)
            )
    return SendResult(sent=sent, retried=retried, failed=failed)


def send_pending_emails_job() -> None:
    settings = get_audit_settings()
    sender = SmtpEmailSender(settings.smtp_host, settings.smtp_port, settings.smtp_timeout_seconds)
    result = send_pending_emails(session_factory(), sender, settings)
    if result != SendResult():
        logger.info(
            "audit emails processed",
            extra={"sent": result.sent, "retried": result.retried, "failed": result.failed},
        )
