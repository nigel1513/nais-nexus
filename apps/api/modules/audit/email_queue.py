"""Kick the email sender after the notifier's transaction commits (never before: the actor would find nothing).

The actor is declared in jobs.register_worker (worker process only). Without one, the 5-minute scan sends mail.
"""

import logging
from typing import Protocol

from sqlalchemy import event as sa_event
from sqlalchemy.orm import Session

logger = logging.getLogger("nais.audit")


class Sendable(Protocol):
    def send(self) -> object: ...


_state: dict[str, Sendable | None] = {"actor": None}


def set_send_actor(actor: Sendable | None) -> None:
    _state["actor"] = actor


def _kick(session: Session) -> None:
    actor = _state["actor"]
    if actor is None:
        return
    try:
        actor.send()
    except Exception:
        logger.warning("could not enqueue email send; the retry scan will pick it up", exc_info=True)


def enqueue_after_commit(session: Session) -> None:
    sa_event.listen(session, "after_commit", _kick, once=True)
