"""getFileHistory and getDatasetCitation (spec §3.3b, §4)."""

import json
from typing import Any

import pytest
from sqlalchemy import create_engine, event, text

from api.modules.catalog.service import history
from api.modules.catalog.tests.support import ORG_B, execute
from api.modules.catalog.tests.support_api import CatalogApi, assert_error
from api.modules.catalog.tests.support_upload import sha, upload_files
from api.modules.catalog.tests.test_contributors import A_RESEARCHER, B_RESEARCHER
from api.modules.catalog.tests.test_contributors import put as put_contributors
from api.modules.catalog.tests.test_versioning_drafts import draft, first_published, publish
from api.platform.db import engine_for
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls


def _history(api: CatalogApi, dataset_id: str, path: str, user: str = "b.researcher") -> dict[str, Any]:
    response = api.get(user, f"/datasets/{dataset_id}/file-history", params={"path": path})
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    assert_matches_response("getFileHistory", 200, body)
    return body


def _four_versions(api: CatalogApi, db: PgUrls) -> tuple[str, list[str]]:
    """v1 adds data/a.csv, v2 changes it, v3 removes it, v4 inherits the absence; a v5 draft exists."""
    dataset_id, v1 = first_published(api, db)
    v2 = draft(api, dataset_id, "v2")["dataset_version_id"]
    upload_files(api, db, v2, {"data/a.csv": b"x,y\n3,3\n"})
    publish(api, v2)
    v3 = draft(api, dataset_id, "v3")["dataset_version_id"]
    files = api.get("b.steward", f"/dataset-versions/{v3}").json()["files"]
    a = next(f for f in files if f["path"] == "data/a.csv")
    assert api.delete("b.steward", f"/dataset-versions/{v3}/files/{a['file_id']}").status_code == 204
    publish(api, v3)
    v4 = draft(api, dataset_id, "v4")["dataset_version_id"]
    publish(api, v4)
    draft(api, dataset_id, "v5-draft")  # drafts never appear
    return dataset_id, [v1, v2, v3, v4]


def test_file_history_states(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, ids = _four_versions(api, db)
    body = _history(api, dataset_id, "data/a.csv")
    assert body["dataset_id"] == dataset_id and body["path"] == "data/a.csv"
    assert [(i["version_label"], i["state"]) for i in body["items"]] == [
        ("v1", "ADDED"),
        ("v2", "CHANGED"),
        ("v3", "REMOVED"),
        ("v4", "ABSENT"),
    ]
    assert [i["dataset_version_id"] for i in body["items"]] == ids  # oldest first (contract)
    assert body["items"][1]["sha256"] == sha(b"x,y\n3,3\n") and body["items"][1]["size_bytes"] == 8
    assert body["items"][2]["sha256"] is None and body["items"][2]["size_bytes"] is None
    # Inherited spans are UNCHANGED: README.md is the same object in every version.
    assert [i["state"] for i in _history(api, dataset_id, "README.md")["items"]] == [
        "ADDED",
        "UNCHANGED",
        "UNCHANGED",
        "UNCHANGED",
    ]
    assert [i["state"] for i in _history(api, dataset_id, "never.csv")["items"]] == ["ABSENT"] * 4


def test_withdrawn_versions_only_for_owner_stewards_and_admins(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, ids = _four_versions(api, db)
    execute(
        db, "UPDATE catalog.dataset_versions SET status = 'WITHDRAWN' WHERE dataset_version_id = :v", v=ids[1]
    )
    researcher = _history(api, dataset_id, "data/a.csv", "b.researcher")["items"]
    assert [(i["version_label"], i["state"]) for i in researcher] == [
        ("v1", "ADDED"),
        ("v3", "REMOVED"),
        ("v4", "ABSENT"),
    ]
    for user in ("b.steward", "b.admin", "platform.admin"):
        labels = [i["version_label"] for i in _history(api, dataset_id, "data/a.csv", user)["items"]]
        assert labels == ["v1", "v2", "v3", "v4"], user
    assert [i["version_label"] for i in _history(api, dataset_id, "data/a.csv", "a.researcher")["items"]] == [
        "v1",
        "v3",
        "v4",
    ]


def test_file_history_access_and_validation(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, _ = first_published(api, db)
    for params in ({}, {"path": "bad path"}, {"path": "x" * 513}):
        assert_error(
            "getFileHistory",
            api.get("b.researcher", f"/datasets/{dataset_id}/file-history", params=params),
            422,
            "VALIDATION_FAILED",
        )
    execute(db, "UPDATE catalog.datasets SET access_level = 'INTERNAL' WHERE dataset_id = :d", d=dataset_id)
    assert_error(
        "getFileHistory",
        api.get("a.researcher", f"/datasets/{dataset_id}/file-history", params={"path": "README.md"}),
        404,
        "NOT_FOUND",
    )
    assert (
        api.get(None, f"/datasets/{dataset_id}/file-history", params={"path": "README.md"}).status_code == 401
    )


def test_file_history_is_capped_and_keeps_the_predecessor_state(
    api: CatalogApi, db: PgUrls, monkeypatch: pytest.MonkeyPatch
) -> None:
    dataset_id, _ = _four_versions(api, db)
    monkeypatch.setattr(history, "MAX_HISTORY_VERSIONS", 2)
    items = _history(api, dataset_id, "data/a.csv")["items"]
    # the newest two, oldest first; v3 is still REMOVED relative to v2, which is not shown
    assert [(i["version_label"], i["state"]) for i in items] == [("v3", "REMOVED"), ("v4", "ABSENT")]


def test_file_history_queries_do_not_grow_with_versions(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, _ = first_published(api, db)

    def count() -> int:
        statements: list[str] = []
        engine = engine_for(db.app)

        def record(*args: Any) -> None:
            statements.append(str(args[2]))

        event.listen(engine, "before_cursor_execute", record)
        try:
            _history(api, dataset_id, "data/a.csv")
        finally:
            event.remove(engine, "before_cursor_execute", record)
        return sum("dataset_files" in s or "dataset_versions" in s for s in statements)

    one = count()
    assert one >= 2  # the listener sees the versions and files queries
    for label in ("v2", "v3", "v4"):
        publish(api, draft(api, dataset_id, label)["dataset_version_id"])
    assert count() == one


# ---- citation --------------------------------------------------------------------------------------------------


def _cite(api: CatalogApi, version_id: str, style: str | None = None, user: str = "b.researcher") -> str:
    params = {"style": style} if style else {}
    response = api.get(user, f"/dataset-versions/{version_id}/citation", params=params)
    assert response.status_code == 200, response.text
    body = response.json()
    assert_matches_response("getDatasetCitation", 200, body)
    assert body["dataset_version_id"] == version_id and body["style"] == (style or "text")
    content: str = body["content"]
    return content


def _people(api: CatalogApi, dataset_id: str) -> dict[str, Any]:
    people: dict[str, Any] = api.get("b.steward", f"/datasets/{dataset_id}").json()["people"]
    return people


def test_citation_styles_and_draft_refusal(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, v1 = first_published(api, db)
    for style in ("text", "bibtex", "datacite-json"):
        _cite(api, v1, style)
    data = json.loads(_cite(api, v1, "datacite-json"))
    assert data["identifiers"][0]["identifier"].endswith(f"/id/dataset-version/{v1}")
    assert data["identifiers"][0]["identifier"].startswith(api.deps.settings.nais_public_base_url.rstrip("/"))
    assert data["version"] == "v1" and data["rightsList"] == [{"rights": "CC-BY-4.0"}]
    org = api.deps.organizations.get_organization_summary(ORG_B)
    assert org is not None and data["publisher"] == {"name": org.name}
    assert _cite(api, v1) == _cite(api, v1, "text")  # text is the default
    assert "@misc{nais_" in _cite(api, v1, "bibtex") and "version = {v1}" in _cite(api, v1, "bibtex")
    d = draft(api, dataset_id, "v2")["dataset_version_id"]
    assert_error(
        "getDatasetCitation",
        api.get("b.steward", f"/dataset-versions/{d}/citation"),
        409,
        "DATASET_VERSION_NOT_PUBLISHED",
    )
    assert_error(
        "getDatasetCitation", api.get("a.researcher", f"/dataset-versions/{d}/citation"), 404, "NOT_FOUND"
    )
    # An unknown style is a 422 (as in the web mock); the contract does not list 422 for this operation yet, so
    # only the envelope is checked here (reported to the controller).
    bad = api.get("b.researcher", f"/dataset-versions/{v1}/citation", params={"style": "apa"})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "VALIDATION_FAILED"


def test_withdrawn_citation_follows_visibility(api: CatalogApi, db: PgUrls) -> None:
    _, v1 = first_published(api, db)
    execute(
        db, "UPDATE catalog.dataset_versions SET status = 'WITHDRAWN' WHERE dataset_version_id = :v", v=v1
    )
    assert "(Version v1)" in _cite(api, v1, user="b.steward")
    assert_error(
        "getDatasetCitation", api.get("b.researcher", f"/dataset-versions/{v1}/citation"), 404, "NOT_FOUND"
    )


def test_citation_uses_the_frozen_snapshot_and_dedupes_the_pi(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, v1 = first_published(api, db)  # PI = b.researcher (Institute B)
    v2 = draft(api, dataset_id, "v2")["dataset_version_id"]
    # The PI also listed as co-investigator, plus a cross-org co-investigator and a non-creator role.
    response = put_contributors(
        api,
        dataset_id,
        [
            {"user_id": str(B_RESEARCHER), "role": "CO_INVESTIGATOR"},
            {"user_id": str(A_RESEARCHER), "role": "CO_INVESTIGATOR"},
        ],
    )
    assert response.status_code == 200, response.text
    people = _people(api, dataset_id)
    pi, co = people["principal_investigator"], people["contributors"][1]
    publish(api, v2)
    # After publish: the title, the people and the license change; v2's citation keeps what was frozen.
    assert (
        api.patch(
            "b.steward",
            f"/datasets/{dataset_id}",
            json={"title": "Renamed later", "license": "CC0-1.0"},
        ).status_code
        == 200
    )
    assert put_contributors(api, dataset_id, []).status_code == 200
    data = json.loads(_cite(api, v2, "datacite-json"))
    assert data["titles"] == [{"title": "Battery Cycling Measurements"}]
    assert data["rightsList"] == [{"rights": "CC-BY-4.0"}]
    assert [c["name"] for c in data["creators"]] == [pi["display_name"], co["display_name"]]  # PI once
    assert data["creators"][1]["affiliation"] == [{"name": co["affiliation"]["name"]}]  # at the time
    assert all(c["nameType"] == "Personal" for c in data["creators"])
    text = _cite(api, v2)
    assert text.startswith(f"{pi['display_name']}, {co['display_name']} (")
    assert "Renamed later" not in text and "@" not in text.split(" http")[0]  # no emails anywhere


def test_citation_without_people_falls_back_to_the_publisher(api: CatalogApi, db: PgUrls) -> None:
    """A snapshot frozen before people existed (Stage 1) has no creators: the owner institute is the creator."""
    _, v1 = first_published(api, db)
    engine = create_engine(db.superuser)
    try:
        with engine.begin() as conn:  # published snapshots are immutable: bypass the trigger as a legacy row
            conn.execute(text("SET LOCAL session_replication_role = replica"))
            conn.execute(
                text(
                    "UPDATE catalog.dataset_versions SET metadata_snapshot = metadata_snapshot - 'people'"
                    " WHERE dataset_version_id = :v"
                ),
                {"v": v1},
            )
    finally:
        engine.dispose()
    data = json.loads(_cite(api, v1, "datacite-json"))
    org = api.deps.organizations.get_organization_summary(ORG_B)
    assert org is not None
    assert data["creators"] == [{"name": org.name, "nameType": "Organizational"}]
    assert "  author = {{" in _cite(api, v1, "bibtex")  # the organization is braced
