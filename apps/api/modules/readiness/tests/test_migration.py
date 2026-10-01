import uuid
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError

from api.modules.readiness.tables import check_results, validations
from api.platform.db import session_factory
from api.platform.testing.fixtures import PgUrls


def _row(**overrides: Any) -> dict[str, Any]:
    row = {
        "validation_id": uuid.uuid4(),
        "dataset_version_id": uuid.uuid4(),
        "dataset_id": uuid.uuid4(),
        "owner_organization_id": uuid.uuid4(),
        "profile_id": "GENERIC_BASIC",
        "profile_version": "1.0.0",
        "validator_version": "1.0.0",
        "input_fingerprint": "a" * 64,
        "run_status": "QUEUED",
        "triggered_by": "USER",
        "attempt": 0,
        "correlation_id": uuid.uuid4(),
    }
    return {**row, **overrides}


def _insert(db: PgUrls, *rows: dict[str, Any]) -> None:
    with session_factory(db.app)() as session, session.begin():
        for row in rows:
            session.execute(validations.insert().values(**row))


DONE = {
    "run_status": "COMPLETED",
    "overall_status": "PASS",
    "result_sha256": "b" * 64,
    "completed_at": text("now()"),
}


def _result(validation_id: uuid.UUID, **overrides: Any) -> dict[str, Any]:
    result = {
        "validation_id": validation_id,
        "check_id": "metadata.completeness",
        "ordinal": 1,
        "severity": "REQUIRED",
        "status": "PASS",
        "message": "ok",
        "evidence": {},
    }
    return {**result, **overrides}


def _completed_run(db: PgUrls) -> dict[str, Any]:
    row = _row(run_status="RUNNING")
    _insert(db, row)
    with session_factory(db.app)() as session, session.begin():
        session.execute(check_results.insert().values(**_result(row["validation_id"])))
        session.execute(
            validations.update().where(validations.c.validation_id == row["validation_id"]).values(**DONE)
        )
    return row


def test_version_table_lives_in_readiness_schema(db: PgUrls) -> None:
    with session_factory(db.migrator)() as session:
        version = session.execute(text("SELECT version_num FROM readiness.alembic_version")).scalar_one()
    assert version == "readiness_0001"


def test_one_inflight_run_per_version_and_profile(db: PgUrls) -> None:
    first = _row()
    _insert(db, first)
    with pytest.raises(IntegrityError):
        _insert(db, _row(dataset_version_id=first["dataset_version_id"], run_status="RUNNING"))
    _insert(db, _row(dataset_version_id=first["dataset_version_id"], profile_id="TABULAR_ML_BASIC"))


def test_one_completed_result_per_fingerprint(db: PgUrls) -> None:
    first = _row(**DONE)
    _insert(db, first)
    with pytest.raises(IntegrityError):
        _insert(db, _row(dataset_version_id=first["dataset_version_id"], **DONE))


@pytest.mark.parametrize(
    "overrides",
    [
        {"run_status": "COMPLETED"},  # no overall/result/completed_at
        {"run_status": "FAILED"},  # no error
        {"overall_status": "PASS"},  # overall only when COMPLETED
        {"profile_id": "FOO"},
        {"triggered_by": "CRON"},
    ],
)
def test_check_constraints(db: PgUrls, overrides: dict[str, Any]) -> None:
    with pytest.raises(IntegrityError):
        _insert(db, _row(**overrides))


def test_check_results_are_immutable_once_completed(db: PgUrls) -> None:
    row = _completed_run(db)
    result = _result(row["validation_id"])
    with pytest.raises(DBAPIError, match="immutable"), session_factory(db.app)() as session, session.begin():
        session.execute(check_results.update().values(status="FAIL"))
    with pytest.raises(DBAPIError, match="immutable"), session_factory(db.app)() as session, session.begin():
        session.execute(
            check_results.insert().values(**{**result, "check_id": "schema.presence", "ordinal": 2})
        )


def test_app_role_cannot_bypass_immutability(db: PgUrls) -> None:
    """The app role has plain DML only: delete, un-complete, move a result, truncate or drop the trigger."""
    row = _completed_run(db)
    other = _row(run_status="RUNNING")
    _insert(db, other)
    attempts = [
        "DELETE FROM readiness.check_results",
        "DELETE FROM readiness.validations",
        "UPDATE readiness.validations SET run_status = 'RUNNING', overall_status = NULL",
        f"UPDATE readiness.check_results SET validation_id = '{other['validation_id']}'",
    ]
    for sql in attempts:
        with pytest.raises(DBAPIError), session_factory(db.app)() as session, session.begin():
            session.execute(text(sql))
    for sql in (
        "TRUNCATE readiness.check_results",
        "ALTER TABLE readiness.check_results DISABLE TRIGGER trg_check_results_immutable",
        "DROP TRIGGER trg_check_results_immutable ON readiness.check_results",
    ):
        with pytest.raises(DBAPIError, match="permission|owner"), session_factory(db.app)() as s, s.begin():
            s.execute(text(sql))
    with session_factory(db.app)() as session:
        count = session.execute(
            text("SELECT count(*) FROM readiness.check_results WHERE validation_id = :v"),
            {"v": row["validation_id"]},
        ).scalar_one()
    assert count == 1


def test_evidence_size_is_capped(db: PgUrls) -> None:
    row = _row(run_status="RUNNING")
    _insert(db, row)
    with pytest.raises(IntegrityError), session_factory(db.app)() as session, session.begin():
        session.execute(
            check_results.insert().values(
                **_result(row["validation_id"], check_id="x", evidence={"blob": "x" * 140_000})
            )
        )
