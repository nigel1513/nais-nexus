import uuid

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from api.platform.db import session_factory
from api.platform.events import EventActor
from api.platform.modules import ModuleSpec
from api.platform.outbox import OutboxWriter, outbox_events
from api.platform.seed import run_seed
from api.platform.testing.fixtures import PgUrls


def count_events(url: str) -> int:
    with session_factory(url)() as session:
        return int(session.execute(select(func.count()).select_from(outbox_events)).scalar_one())


def publish(session: Session) -> None:
    OutboxWriter().write(
        session, "project.archived.v1", {"project_id": str(uuid.uuid4())}, EventActor.system()
    )


def test_seeds_run_in_order_and_skip_modules_without_seed(migrated_db: PgUrls) -> None:
    order: list[str] = []
    specs = [
        ModuleSpec(name="identity", seed=lambda s: order.append("identity")),
        ModuleSpec(name="project"),
        ModuleSpec(name="catalog", seed=lambda s: order.append("catalog")),
    ]
    assert run_seed(specs, url=migrated_db.app) == ["identity", "catalog"]
    assert order == ["identity", "catalog"]


def test_failing_seed_rolls_back_its_own_writes(migrated_db: PgUrls) -> None:
    before = count_events(migrated_db.app)

    def broken(session: Session) -> None:
        publish(session)
        raise RuntimeError("seed failed")

    with pytest.raises(RuntimeError):
        run_seed([ModuleSpec(name="catalog", seed=broken)], url=migrated_db.app)
    assert count_events(migrated_db.app) == before
