"""AT-14: two OWNERs acting on each other at the same time must leave >= 1 ACTIVE owner."""

import threading
from collections.abc import Callable
from uuid import UUID

from sqlalchemy.orm import Session

from api.modules.project import service
from api.modules.project.schemas import ProjectCreateIn
from api.modules.project.seed_data import USERS_BY_KEY
from api.modules.project.tests.helpers import current_user_for, seed_member, sql
from api.platform.db import session_factory, session_scope
from api.platform.errors import ApiError
from api.platform.testing.fixtures import PgUrls

A_RESEARCHER = USERS_BY_KEY["a.researcher"].user_id
A_ADMIN = USERS_BY_KEY["a.admin"].user_id


def _two_owner_project(db: PgUrls) -> UUID:
    with session_scope(db.app) as session:
        project_id = service.create_project(
            session, current_user_for("a.researcher"), ProjectCreateIn(name="Race Study", description="")
        )
    seed_member(db, str(project_id), "a.admin", "PROJECT_OWNER")
    return project_id


def _race(db: PgUrls, first: Callable[[Session], object], rival: Callable[[Session], object]) -> str:
    """Run `first` in an open transaction, start `rival` (must block on the row lock), then commit `first`."""
    factory = session_factory(db.app)
    outcome: dict[str, str] = {}

    def run_rival() -> None:
        with factory() as session:
            try:
                rival(session)
                session.commit()
                outcome["code"] = "OK"
            except ApiError as exc:
                session.rollback()
                outcome["code"] = exc.code.value
            except Exception as exc:
                session.rollback()
                outcome["code"] = f"UNEXPECTED:{type(exc).__name__}"

    first_session = factory()
    thread = threading.Thread(target=run_rival, daemon=True)
    try:
        first(first_session)
        thread.start()
        thread.join(timeout=1.0)
        assert thread.is_alive(), "rival must wait for the projects row lock"
        first_session.commit()
        thread.join(timeout=10)
        assert not thread.is_alive()
    finally:
        first_session.close()
        if thread.is_alive():
            thread.join(timeout=10)
    return outcome.get("code", "NO_OUTCOME")


def _owners(db: PgUrls, project_id: UUID) -> int:
    rows = sql(
        db,
        "SELECT count(*) AS n FROM project.project_members "
        "WHERE project_id = :p AND status = 'ACTIVE' AND role = 'PROJECT_OWNER'",
        p=str(project_id),
    )
    return int(rows[0]["n"])


def test_at14_owners_demoting_each_other_concurrently(db: PgUrls) -> None:
    project_id = _two_owner_project(db)
    code = _race(
        db,
        lambda s: service.change_member_role(
            s, current_user_for("a.researcher"), project_id, A_ADMIN, "RESEARCHER"
        ),
        lambda s: service.change_member_role(
            s, current_user_for("a.admin"), project_id, A_RESEARCHER, "RESEARCHER"
        ),
    )
    # After the lock is released the rival re-reads its own role: it is no longer an OWNER.
    assert code == "FORBIDDEN"
    assert _owners(db, project_id) == 1


def test_at14_owners_leaving_concurrently(db: PgUrls) -> None:
    project_id = _two_owner_project(db)
    code = _race(
        db,
        lambda s: service.remove_member(s, current_user_for("a.researcher"), project_id, A_RESEARCHER),
        lambda s: service.remove_member(s, current_user_for("a.admin"), project_id, A_ADMIN),
    )
    assert code == "PROJECT_LAST_OWNER"
    assert _owners(db, project_id) == 1
