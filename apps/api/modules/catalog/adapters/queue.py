"""Dramatiq-backed VerificationQueue: one catalog.verify_file message per file (M03 §10).

Messages go to the broker configured *now* (dramatiq.get_broker()), not to the broker the actor happened to bind
when the module was imported: under pytest the package is imported before any broker is configured.
"""

from collections.abc import Sequence
from uuid import UUID

import dramatiq

from api.platform.context import correlation_id


class DramatiqVerificationQueue:
    def enqueue(self, file_ids: Sequence[UUID]) -> None:
        from api.modules.catalog.jobs import verify_file_actor  # jobs.py defines the actor (Task 11)

        broker = dramatiq.get_broker()
        if verify_file_actor.actor_name not in broker.get_declared_actors():
            broker.declare_actor(verify_file_actor)
        for file_id in file_ids:
            broker.enqueue(
                verify_file_actor.message_with_options(
                    args=(str(file_id),), correlation_id=str(correlation_id())
                )
            )
