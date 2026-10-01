"""HTTP contract and authorization (M05 §6, §9): M05-AT-03..09, M05-AT-12."""

import dataclasses
import sys
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select, update

from api.modules.readiness import jobs
from api.modules.readiness.catalog_port import CatalogQueryPort, VersionView
from api.modules.readiness.fakes import FIXTURES_ROOT, FixtureCatalog
from api.modules.readiness.service import RequestNotSettled
from api.modules.readiness.tables import validations
from api.modules.readiness.tests.dbutil import events, queued_messages
from api.modules.readiness.tests.helpers import ORG_B, clean_snapshot
from api.platform import ports
from api.platform.db import session_factory
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls


def auth(client: TestClient, user: str) -> dict[str, str]:
    """Bearer token from the fixture's FakeIssuer; `sub` is a key of helpers.USERS (see conftest.FakePrincipals)."""
    return {"Authorization": f"Bearer {client.issuer.token(sub=user)}"}  # type: ignore[attr-defined]


def start(client: TestClient, version_id: Any, user: str, profile_id: str = "TABULAR_ML_BASIC") -> Any:
    return client.post(
        f"/api/v1/dataset-versions/{version_id}/readiness-validations",
        json={"profile_id": profile_id},
        headers=auth(client, user),
    )


def readiness(client: TestClient, version_id: Any, user: str, **params: str) -> Any:
    return client.get(
        f"/api/v1/dataset-versions/{version_id}/readiness", params=params, headers=auth(client, user)
    )


def error_code(response: Any) -> str:
    return str(response.json()["error"]["code"])


def run_all(db: PgUrls) -> None:
    with session_factory(db.app)() as session:
        ids = session.execute(select(validations.c.validation_id).where(validations.c.run_status == "QUEUED"))
        for vid in list(ids.scalars()):
            jobs.run_validation(vid)


# ---------------------------------------------------------------- listReadinessProfiles


def test_list_profiles_for_any_authenticated_user(client: TestClient) -> None:
    response = client.get("/api/v1/readiness-profiles", headers=auth(client, "a_researcher"))
    assert response.status_code == 200
    assert_matches_response("listReadinessProfiles", 200, response.json())
    assert [p["profile_id"] for p in response.json()["items"]] == ["GENERIC_BASIC", "TABULAR_ML_BASIC"]


def test_list_profiles_requires_a_token(client: TestClient) -> None:
    response = client.get("/api/v1/readiness-profiles")
    assert (response.status_code, error_code(response)) == (401, "UNAUTHENTICATED")
    assert_matches_response(
        "listReadinessProfiles", 401, response.json()
    )  # declared since contract 1.2.0 (M00)


# ---------------------------------------------------------------- startReadinessValidation


def test_steward_starts_a_validation(client: TestClient, catalog: FixtureCatalog, db: PgUrls) -> None:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    response = start(client, view.dataset_version_id, "b_steward")
    assert response.status_code == 202
    body = response.json()
    assert_matches_response("startReadinessValidation", 202, body)
    assert (body["run_status"], body["triggered_by"], body["checks"]) == ("QUEUED", "USER", [])
    assert body["overall_status"] is None
    assert len(queued_messages()) == 1


def test_platform_admin_may_start(client: TestClient, catalog: FixtureCatalog) -> None:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    assert start(client, view.dataset_version_id, "admin").status_code == 202


def test_completed_result_is_reused(client: TestClient, catalog: FixtureCatalog, db: PgUrls) -> None:
    """M05-AT-03."""
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    first = start(client, view.dataset_version_id, "b_steward").json()
    run_all(db)
    outbox_before = len(events(db))
    response = start(client, view.dataset_version_id, "b_steward")
    assert response.status_code == 200
    body = response.json()
    assert_matches_response("startReadinessValidation", 200, body)
    assert body["validation_id"] == first["validation_id"]
    assert (body["run_status"], body["overall_status"], len(body["checks"])) == ("COMPLETED", "PASS", 9)
    with session_factory(db.app)() as session:
        assert session.execute(select(func.count()).select_from(validations)).scalar_one() == 1
    assert len(events(db)) == outbox_before
    assert len(queued_messages()) == 1  # only the first request enqueued a job


def test_running_validation_blocks_a_second_request(
    client: TestClient, catalog: FixtureCatalog, db: PgUrls
) -> None:
    """M05-AT-04."""
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    first = start(client, view.dataset_version_id, "b_steward").json()
    with session_factory(db.app)() as session, session.begin():
        session.execute(update(validations).values(run_status="RUNNING", attempt=1))
    response = start(client, view.dataset_version_id, "b_steward")
    assert response.status_code == 409
    assert_matches_response("startReadinessValidation", 409, response.json())
    assert error_code(response) == "READINESS_VALIDATION_IN_PROGRESS"
    assert response.json()["error"]["details"] == {"validation_id": first["validation_id"]}


def test_draft_version_is_rejected(client: TestClient, catalog: FixtureCatalog) -> None:
    """M05-AT-05."""
    draft = catalog.add_version({}, None, owner_organization_id=ORG_B, status="DRAFT")
    response = start(client, draft.dataset_version_id, "b_steward")
    assert (response.status_code, error_code(response)) == (409, "DATASET_VERSION_NOT_PUBLISHED")


@pytest.mark.parametrize("user", ["a_researcher", "a_steward", "b_researcher", "b_orgadmin"])
def test_non_owner_steward_is_forbidden(client: TestClient, catalog: FixtureCatalog, user: str) -> None:
    """M05-AT-06 (+ same-org non-steward, other-org steward)."""
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    response = start(client, view.dataset_version_id, user)
    assert (response.status_code, error_code(response)) == (403, "FORBIDDEN")
    assert_matches_response("startReadinessValidation", 403, response.json())


def test_unknown_profile_is_rejected(client: TestClient, catalog: FixtureCatalog) -> None:
    """M05-AT-07."""
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    response = start(client, view.dataset_version_id, "b_steward", profile_id="FOO")
    assert (response.status_code, error_code(response)) == (422, "READINESS_PROFILE_UNKNOWN")
    assert_matches_response("startReadinessValidation", 422, response.json())


def test_extra_body_fields_are_rejected(client: TestClient, catalog: FixtureCatalog) -> None:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    response = client.post(
        f"/api/v1/dataset-versions/{view.dataset_version_id}/readiness-validations",
        json={"profile_id": "GENERIC_BASIC", "reuse": False},
        headers=auth(client, "b_steward"),
    )
    assert (response.status_code, error_code(response)) == (422, "VALIDATION_FAILED")


def test_unknown_or_invisible_version_is_404(client: TestClient, catalog: FixtureCatalog) -> None:
    internal = catalog.add_fixture("invalid_units", owner_organization_id=ORG_B, access_level="INTERNAL")
    for response in (
        start(client, internal.dataset_version_id, "a_steward"),
        start(client, "0199a000-0000-7000-8000-000000000000", "b_steward"),
    ):
        assert (response.status_code, error_code(response)) == (404, "NOT_FOUND")
        assert_matches_response(
            "startReadinessValidation", 404, response.json()
        )  # declared since 1.2.0 (M00)


def test_tabular_profile_on_non_tabular_version_is_allowed(
    client: TestClient, catalog: FixtureCatalog
) -> None:
    view = catalog.add_version({"README.md": b"# x\n"}, clean_snapshot(), owner_organization_id=ORG_B)
    assert start(client, view.dataset_version_id, "b_steward").status_code == 202


# ---------------------------------------------------------------- getReadiness


def _completed(client: TestClient, catalog: FixtureCatalog, db: PgUrls, **kwargs: Any) -> VersionView:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B, **kwargs)
    for profile_id in ("GENERIC_BASIC", "TABULAR_ML_BASIC"):
        assert start(client, view.dataset_version_id, "b_steward", profile_id).status_code == 202
    run_all(db)
    return view


def test_get_readiness_returns_latest_per_profile(
    client: TestClient, catalog: FixtureCatalog, db: PgUrls
) -> None:
    view = _completed(client, catalog, db)
    response = readiness(client, view.dataset_version_id, "a_researcher")
    assert response.status_code == 200
    assert_matches_response("getReadiness", 200, response.json())
    items = response.json()["items"]
    assert [i["profile_id"] for i in items] == ["GENERIC_BASIC", "TABULAR_ML_BASIC"]
    assert [c["check_id"] for c in items[1]["checks"]][:2] == ["metadata.completeness", "provenance.presence"]
    assert items[1]["summary"] == {"pass": 9, "warning": 0, "fail": 0, "not_applicable": 0}
    only = readiness(client, view.dataset_version_id, "a_researcher", profile_id="GENERIC_BASIC").json()[
        "items"
    ]
    assert [i["profile_id"] for i in only] == ["GENERIC_BASIC"]


def test_latest_includes_in_flight_and_failed_runs(
    client: TestClient, catalog: FixtureCatalog, db: PgUrls
) -> None:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    start(client, view.dataset_version_id, "b_steward")
    [item] = readiness(client, view.dataset_version_id, "b_steward").json()["items"]
    assert (item["run_status"], item["checks"]) == ("QUEUED", [])
    jobs.fail_run(uuid.UUID(item["validation_id"]), "STALE_JOB: test", from_statuses=("QUEUED",))
    [item] = readiness(client, view.dataset_version_id, "b_steward").json()["items"]
    assert (item["run_status"], item["overall_status"], item["error"]) == ("FAILED", None, "STALE_JOB: test")
    assert_matches_response("getReadiness", 200, {"items": [item]})


def test_no_results_and_unknown_profile(client: TestClient, catalog: FixtureCatalog) -> None:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    assert readiness(client, view.dataset_version_id, "b_steward").json() == {"items": []}
    response = readiness(client, view.dataset_version_id, "b_steward", profile_id="GENERIC_BASIC")
    assert (response.status_code, error_code(response)) == (404, "READINESS_NOT_AVAILABLE")
    assert_matches_response("getReadiness", 404, response.json())


def test_draft_version_readiness_is_404(client: TestClient, catalog: FixtureCatalog) -> None:
    draft = catalog.add_version({}, None, owner_organization_id=ORG_B, status="DRAFT")
    response = readiness(client, draft.dataset_version_id, "b_steward")
    assert (response.status_code, error_code(response)) == (404, "NOT_FOUND")


def test_internal_dataset_is_404_for_other_institutions(
    client: TestClient, catalog: FixtureCatalog, db: PgUrls
) -> None:
    """M05-AT-08."""
    view = _completed(client, catalog, db, access_level="INTERNAL")
    response = readiness(client, view.dataset_version_id, "a_researcher")
    assert (response.status_code, error_code(response)) == (404, "NOT_FOUND")
    assert readiness(client, view.dataset_version_id, "b_researcher").status_code == 200


def test_controlled_evidence_never_leaks_cell_values(
    client: TestClient, catalog: FixtureCatalog, db: PgUrls
) -> None:
    """M05-AT-09: grant-less Institute A user reads Institute B CONTROLLED results."""
    view = _completed(client, catalog, db)
    assert view.metadata_snapshot is not None and view.metadata_snapshot["access_level"] == "CONTROLLED"
    response = readiness(client, view.dataset_version_id, "a_researcher")
    assert response.status_code == 200
    text = response.text
    csv_lines = (FIXTURES_ROOT / "clean_tabular/files/data/measurements.csv").read_text().splitlines()[1:]
    cells = {
        cell for line in csv_lines for cell in (line.split(",")[0], line.split(",")[3], line.split(",")[4])
    }
    cells.discard("")
    assert {"S0001", "101.325", "2026-01-01T00:01:00Z"} <= cells
    assert sorted(cell for cell in cells | {"Aluminium"} if cell in text) == []


def test_snapshot_not_live_metadata_is_evaluated(
    client: TestClient, catalog: FixtureCatalog, db: PgUrls
) -> None:
    """M05-AT-12: a later PATCH of the live dataset changes nothing for the published version."""
    view = catalog.add_fixture("missing_provenance", owner_organization_id=ORG_B)
    start(client, view.dataset_version_id, "b_steward", "GENERIC_BASIC")
    run_all(db)
    before = readiness(client, view.dataset_version_id, "b_steward").json()
    catalog.live_metadata[view.dataset_id]["provenance"] = "나중에 추가한 출처 설명입니다. " * 5
    response = start(client, view.dataset_version_id, "b_steward", "GENERIC_BASIC")
    assert response.status_code == 200  # same fingerprint -> reused, not re-run
    after = readiness(client, view.dataset_version_id, "b_steward").json()
    assert after == before
    assert after["items"][0]["overall_status"] == "FAIL"


def test_withdrawn_version_keeps_results_but_rejects_new_runs(
    client: TestClient, catalog: FixtureCatalog, db: PgUrls
) -> None:
    """Review focus: WITHDRAWN is not DRAFT - results stay readable, new runs need PUBLISHED."""
    view = _completed(client, catalog, db)
    catalog.replace_view(dataclasses.replace(view, status="WITHDRAWN"))
    assert len(readiness(client, view.dataset_version_id, "b_steward").json()["items"]) == 2
    response = start(client, view.dataset_version_id, "b_steward", "GENERIC_BASIC")
    assert (response.status_code, error_code(response)) == (409, "DATASET_VERSION_NOT_PUBLISHED")


# ---------------------------------------------------------------- 503 (W1-D3): generic body, no internal details


class _Boom:
    """CatalogQueryPort whose backend is down; the message carries an internal host that must not leak."""

    def get_version(self, dataset_version_id: Any) -> Any:
        raise ConnectionError("connect to minio.internal.nais:9000 refused")

    def is_visible(self, ctx: Any, dataset_id: Any) -> bool:
        raise ConnectionError("connect to minio.internal.nais:9000 refused")

    def get_policy_view(self, dataset_id: Any) -> Any:
        raise ConnectionError("connect to minio.internal.nais:9000 refused")


def test_catalog_outage_is_a_generic_503(client: TestClient, catalog: FixtureCatalog) -> None:
    ports.provide(CatalogQueryPort, _Boom())
    try:
        _assert_generic_503(client)
    finally:
        ports.provide(CatalogQueryPort, catalog)


def _assert_generic_503(client: TestClient) -> None:
    vid = "0199a000-0000-7000-8000-000000000001"
    for response in (start(client, vid, "b_steward"), readiness(client, vid, "b_steward")):
        assert (response.status_code, error_code(response)) == (503, "DEPENDENCY_UNAVAILABLE")
        assert "minio" not in response.text and "9000" not in response.text
    assert_matches_response("startReadinessValidation", 503, start(client, vid, "b_steward").json())
    assert_matches_response("getReadiness", 503, readiness(client, vid, "b_steward").json())


def test_missing_catalog_port_is_503(client: TestClient) -> None:
    saved = dict(ports._registry)  # noqa: SLF001
    ports._registry.pop(CatalogQueryPort, None)  # noqa: SLF001  - the real port is unwired
    try:
        vid = "0199a000-0000-7000-8000-000000000001"
        assert readiness(client, vid, "b_steward").status_code == 503
    finally:
        ports._registry.clear()  # noqa: SLF001
        ports._registry.update(saved)  # noqa: SLF001


def test_unsettled_concurrent_request_is_a_generic_503(
    client: TestClient, catalog: FixtureCatalog, monkeypatch: pytest.MonkeyPatch
) -> None:
    def never_settles(*args: Any, **kwargs: Any) -> Any:
        raise RequestNotSettled("could not settle (internal detail)")

    monkeypatch.setattr(sys.modules["api.modules.readiness.router"], "request_validation", never_settles)
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    response = start(client, view.dataset_version_id, "b_steward")
    assert (response.status_code, error_code(response)) == (503, "DEPENDENCY_UNAVAILABLE")
    assert "settle" not in response.text
    assert_matches_response("startReadinessValidation", 503, response.json())


def test_overlong_profile_id_is_a_validation_error(client: TestClient, catalog: FixtureCatalog) -> None:
    view = catalog.add_fixture("clean_tabular", owner_organization_id=ORG_B)
    response = start(client, view.dataset_version_id, "b_steward", profile_id="X" * 65)
    assert (response.status_code, error_code(response)) == (422, "VALIDATION_FAILED")


def test_non_owner_reads_withdrawn_results_only_while_the_dataset_is_visible(
    client: TestClient, catalog: FixtureCatalog, db: PgUrls
) -> None:
    """D-012: a withdrawn-only dataset is invisible to other institutions; with another PUBLISHED version the
    withdrawn version's results stay readable (same rule as M03 can_see_dataset)."""
    view = _completed(client, catalog, db)
    catalog.replace_view(dataclasses.replace(view, status="WITHDRAWN"))
    hidden = readiness(client, view.dataset_version_id, "a_researcher")
    assert (hidden.status_code, error_code(hidden)) == (404, "NOT_FOUND")
    assert readiness(client, view.dataset_version_id, "b_researcher").status_code == 200  # owner institution
    catalog.add_version(
        {"README.md": b"# x\n"}, clean_snapshot(), owner_organization_id=ORG_B, dataset_id=view.dataset_id
    )
    shown = readiness(client, view.dataset_version_id, "a_researcher")
    assert shown.status_code == 200
    assert len(shown.json()["items"]) == 2
