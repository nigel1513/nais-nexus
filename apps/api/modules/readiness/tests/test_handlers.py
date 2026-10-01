"""catalog.dataset.version_published.v1 end to end: outbox -> relay -> handler -> Dramatiq worker -> DB.

M05-AT-01 (4 fixtures x 2 profiles vs golden), M05-AT-11 (duplicate delivery), M05-AT-13 (T empty)."""

import dataclasses
import json

from sqlalchemy import column, func, select, table, update
from sqlalchemy.orm import Session

from api.modules.readiness.catalog_port import VersionView
from api.modules.readiness.fakes import FIXTURES_ROOT, FixtureCatalog
from api.modules.readiness.handlers import on_version_published
from api.modules.readiness.tables import check_results, validations
from api.modules.readiness.tests.dbutil import drain_jobs, events
from api.modules.readiness.tests.helpers import FIXTURE_NAMES, ORG_B, clean_snapshot
from api.platform.db import session_factory
from api.platform.event_bus import HandlerRegistry, claim_event, registry
from api.platform.events import EventActor, EventEnvelope
from api.platform.outbox import outbox, outbox_events
from api.platform.relay import dispatch_batch
from api.platform.testing.fixtures import PgUrls

processed_events = table("processed_events", column("handler"), schema="readiness")


def publish(db: PgUrls, view: VersionView) -> None:
    """What M03 does on publish: the event goes through the platform outbox."""
    payload = {
        "dataset_id": str(view.dataset_id),
        "dataset_version_id": str(view.dataset_version_id),
        "version_label": view.version_label,
        "owner_organization_id": str(view.owner_organization_id),
        "file_count": len(view.files),
        "total_bytes": sum(f.size_bytes for f in view.files),
        "manifest_sha256": view.manifest_sha256,
    }
    with session_factory(db.app)() as session, session.begin():
        outbox.write(session, "catalog.dataset.version_published.v1", payload, EventActor.system())


def relay(db: PgUrls) -> None:
    assert dispatch_batch(session_factory(db.app), registry).dead == 0


def results(db: PgUrls, view: VersionView) -> dict[str, dict[str, object]]:
    with session_factory(db.app)() as session:
        rows = session.execute(
            select(validations).where(validations.c.dataset_version_id == view.dataset_version_id)
        ).mappings()
        out: dict[str, dict[str, object]] = {}
        for r in rows:
            checks = session.execute(
                select(check_results.c.check_id, check_results.c.status).where(
                    check_results.c.validation_id == r["validation_id"]
                )
            ).all()
            out[r["profile_id"]] = {
                "run_status": r["run_status"],
                "overall_status": r["overall_status"],
                "result_sha256": r["result_sha256"],
                "triggered_by": r["triggered_by"],
                "requested_by": r["requested_by"],
                "checks": dict(checks),
            }
    return out


def test_handler_is_registered_for_the_publish_event() -> None:
    names = registry.table()["catalog.dataset.version_published.v1"]
    assert f"{on_version_published.__module__}.on_version_published" in names


def test_publishing_the_four_fixtures_matches_the_golden_results(db: PgUrls, catalog: FixtureCatalog) -> None:
    """M05-AT-01."""
    views = {name: catalog.add_fixture(name, owner_organization_id=ORG_B) for name in FIXTURE_NAMES}
    for view in views.values():
        publish(db, view)
    relay(db)
    drain_jobs()
    for name, view in views.items():
        got = results(db, view)
        assert set(got) == {"GENERIC_BASIC", "TABULAR_ML_BASIC"}, name
        for profile_id, result in got.items():
            expected = json.loads((FIXTURES_ROOT / name / "expected" / f"{profile_id}.json").read_text())
            assert result["run_status"] == "COMPLETED"
            assert (result["triggered_by"], result["requested_by"]) == ("AUTO_ON_PUBLISH", None)
            assert result["overall_status"] == expected["overall_status"], (name, profile_id)
            assert result["checks"] == expected["checks"], (name, profile_id)
            assert result["result_sha256"] == expected["result_sha256"], (name, profile_id)
    published = [e for e in events(db) if e["event_type"] == "catalog.dataset.version_published.v1"]
    completed = [e for e in events(db) if e["event_type"] == "readiness.validation.completed.v1"]
    assert len(completed) == 8
    assert {e["correlation_id"] for e in completed} == {e["correlation_id"] for e in published}
    assert all(e["actor"]["type"] == "SYSTEM" for e in completed)


def test_duplicate_delivery_creates_one_validation_per_profile(db: PgUrls, catalog: FixtureCatalog) -> None:
    """M05-AT-11: the relay redelivers the same event (at-least-once)."""
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    publish(db, view)
    relay(db)
    with session_factory(db.app)() as session, session.begin():
        session.execute(update(outbox_events).values(dispatched_at=None))
    relay(db)
    drain_jobs()
    with session_factory(db.app)() as session:
        counts = dict(
            session.execute(
                select(validations.c.profile_id, func.count()).group_by(validations.c.profile_id)
            ).all()
        )
    assert counts == {"GENERIC_BASIC": 1, "TABULAR_ML_BASIC": 1}


def test_version_without_tabular_files_runs_generic_only(db: PgUrls, catalog: FixtureCatalog) -> None:
    """M05-AT-13: README.md + .h5 only."""
    readme = (
        "# Scan\n\n## Provenance\n\n"
        + "빔라인 BL-7에서 2026년 3월 측정한 원시 HDF5 스캔 파일이며 후처리하지 않았다. " * 2
    )
    view = catalog.add_version(
        {"README.md": readme.encode(), "raw/scan.h5": b"\x89HDF\r\n\x1a\n" + bytes(64)},
        clean_snapshot(),
        owner_organization_id=ORG_B,
    )
    publish(db, view)
    relay(db)
    drain_jobs()
    got = results(db, view)
    assert set(got) == {"GENERIC_BASIC"}
    checks = got["GENERIC_BASIC"]["checks"]
    assert isinstance(checks, dict)
    assert [
        checks[c] for c in ("schema.presence", "semantics.units_codebook", "semantics.mapping_status")
    ] == ["NOT_APPLICABLE"] * 3


def _claims(db: PgUrls) -> list[str]:
    with session_factory(db.app)() as session:
        return sorted(session.execute(select(processed_events.c.handler)).scalars())


def test_unknown_version_is_ignored(db: PgUrls, catalog: FixtureCatalog) -> None:
    ghost = FixtureCatalog().add_fixture("clean_tabular", owner_organization_id=ORG_B)
    publish(db, ghost)
    assert dispatch_batch(session_factory(db.app), registry).dispatched == 1
    result = dispatch_batch(session_factory(db.app), registry)
    assert (result.dispatched, result.retried) == (0, 0)  # settled, not retried
    with session_factory(db.app)() as session:
        assert session.execute(select(func.count()).select_from(validations)).scalar_one() == 0
    assert _claims(db) == ["on_version_published"]


def test_withdrawn_version_is_skipped(db: PgUrls, catalog: FixtureCatalog) -> None:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    catalog.replace_view(dataclasses.replace(view, status="WITHDRAWN"))
    publish(db, view)
    result = dispatch_batch(session_factory(db.app), registry)
    assert (result.dispatched, result.retried, result.dead) == (1, 0, 0)
    with session_factory(db.app)() as session:
        assert session.execute(select(func.count()).select_from(validations)).scalar_one() == 0
    assert _claims(db) == ["on_version_published"]


def test_handler_coexists_with_other_subscribers_of_the_publish_event(
    db: PgUrls, catalog: FixtureCatalog
) -> None:
    """Per-handler claims (D-006): audit_writer / notifier style handlers do not swallow ours or vice versa."""
    seen: list[str] = []

    def audit_writer(session: Session, event: EventEnvelope) -> None:
        if claim_event(session, "readiness", event, handler="audit_writer"):
            seen.append("audit_writer")

    def notifier(session: Session, event: EventEnvelope) -> None:
        if claim_event(session, "readiness", event, handler="notifier"):
            seen.append("notifier")

    local = HandlerRegistry()
    for handler in (audit_writer, on_version_published, notifier):
        local.subscribe("catalog.dataset.version_published.v1")(handler)
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    publish(db, view)
    assert dispatch_batch(session_factory(db.app), local).dispatched == 1
    assert sorted(seen) == ["audit_writer", "notifier"]
    assert _claims(db) == ["audit_writer", "notifier", "on_version_published"]
    assert set(results(db, view)) == {"GENERIC_BASIC", "TABULAR_ML_BASIC"}


def test_missing_catalog_port_retries_the_event_instead_of_dropping_it(db: PgUrls) -> None:
    """Review focus: worker started without M03 wired -> relay retries, the claim is rolled back."""
    view = FixtureCatalog().add_fixture("clean_tabular", owner_organization_id=ORG_B)
    publish(db, view)  # no `catalog` fixture: CatalogQueryPort is not provided
    result = dispatch_batch(session_factory(db.app), registry)
    assert (result.dispatched, result.retried) == (0, 1)
    with session_factory(db.app)() as session:
        assert session.execute(select(func.count()).select_from(processed_events)).scalar_one() == 0
