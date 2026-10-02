"""Project outputs: upload sessions, completion checks, downloads and the inherited access level (spec §5.4;
openapi listOutputs/createOutputUpload/completeOutputUpload/getOutput/getOutputDownload)."""

import hashlib
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, get_args
from uuid import UUID

import pytest

from api.modules.catalog.public import AccessLevel, DatasetPolicyView
from api.modules.workspace.service.outputs import STRICTNESS
from api.modules.workspace.tests.conftest import WorkspaceApi, World, outbox, sql
from api.modules.workspace.tests.fakes import ORG_B, USERS
from api.platform import clock
from api.platform.ids import new_id
from api.platform.testing.contracts import assert_matches_response, assert_valid_event
from api.platform.testing.fixtures import PgUrls

REPORT = b"%PDF-1.7 analysis report"
T = datetime(2026, 10, 1, 6, 0, tzinfo=UTC)


@dataclass
class Setup:
    project_id: UUID
    public: DatasetPolicyView
    controlled: DatasetPolicyView


@pytest.fixture
def setup(world: World) -> Setup:
    project_id = new_id()
    world.projects.add(project_id, USERS["a.owner"], "PROJECT_OWNER")  # lead organization: ORG_A (inst-a)
    world.projects.add(project_id, USERS["a.researcher"], "RESEARCHER")
    world.projects.add(project_id, USERS["a.viewer"], "VIEWER")
    public = world.catalog.add_dataset("공개 측정", "PUBLIC")
    world.catalog.add_version(public, "v1")
    controlled = world.catalog.add_dataset("이차전지 충방전 측정", "CONTROLLED", owner=ORG_B)
    world.catalog.add_version(controlled, "v2")
    return Setup(project_id, public, controlled)


def error_code(response: Any) -> str:
    return str(response.json()["error"]["code"])


def file_spec(name: str = "report.pdf", data: bytes = REPORT, **extra: Any) -> dict[str, Any]:
    spec = {
        "name": name,
        "size_bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "media_type": "application/pdf",
    }
    return spec | extra


def start(
    api: WorkspaceApi,
    project_id: UUID,
    access_level: str = "INTERNAL",
    user: str = "a.researcher",
    files: list[dict[str, Any]] | None = None,
    **extra: Any,
) -> Any:
    body = {
        "title": "분석 보고서 초안",
        "access_level": access_level,
        "files": [file_spec()] if files is None else files,
    }
    return api.post(user, f"/projects/{project_id}/outputs", json=body | extra)


def pin(api: WorkspaceApi, project_id: UUID, dataset: DatasetPolicyView) -> dict[str, Any]:
    response = api.post(
        "a.researcher", f"/projects/{project_id}/inputs", json={"dataset_id": str(dataset.dataset_id)}
    )
    assert response.status_code == 201, response.text
    return dict(response.json())


def key(project_id: UUID, output_id: str, name: str = "report.pdf") -> str:
    return f"workspace/{project_id}/outputs/{output_id}/{name}"


def uploaded(
    api: WorkspaceApi, world: World, project_id: UUID, access_level: str = "INTERNAL", data: bytes = REPORT
) -> dict[str, Any]:
    """A completed FILE output (session, object stored, complete)."""
    session = start(api, project_id, access_level)
    assert session.status_code == 201, session.text
    output_id = session.json()["output_id"]
    world.storage.put("inst-a", key(project_id, output_id), data)
    done = api.post("a.researcher", f"/projects/{project_id}/outputs/{output_id}/complete")
    assert done.status_code == 200, done.text
    return dict(done.json())


# ---------------------------------------------------------------- access level order


def test_strictness_order_matches_the_contract_access_levels() -> None:
    assert STRICTNESS == get_args(AccessLevel) == ("PUBLIC", "INTERNAL", "CONTROLLED", "SENSITIVE")


# ---------------------------------------------------------------- upload session


def test_upload_session_presigns_puts_under_the_lead_organization_bucket(
    api: WorkspaceApi, setup: Setup, world: World, db: PgUrls
) -> None:
    with clock.frozen(T):
        response = start(api, setup.project_id)
    assert response.status_code == 201, response.text
    assert_matches_response("createOutputUpload", 201, response.json())
    body = response.json()
    output_id = body["output_id"]
    assert body["expires_at"].replace("Z", "+00:00") == (T + timedelta(minutes=15)).isoformat()
    [entry] = body["files"]
    assert entry["name"] == "report.pdf"
    assert entry["upload"]["method"] == "PUT"
    assert entry["upload"]["headers"] == {"Content-Type": "application/pdf"}
    assert world.storage.presigned == [("PUT", "inst-a", key(setup.project_id, output_id), 900)]
    # a session is not an output yet: no event, not listed, not readable
    assert outbox(db) == []
    listed = api.get("a.researcher", f"/projects/{setup.project_id}/outputs")
    assert listed.status_code == 200 and listed.json()["items"] == []
    assert api.get("a.researcher", f"/projects/{setup.project_id}/outputs/{output_id}").status_code == 404


def test_upload_needs_a_writer_of_an_active_project(api: WorkspaceApi, setup: Setup, world: World) -> None:
    for user in ("a.viewer", "a.outsider", "b.researcher"):
        response = start(api, setup.project_id, user=user)
        assert (response.status_code, error_code(response)) == (403, "FORBIDDEN"), user
    world.projects.archived.add(setup.project_id)
    response = start(api, setup.project_id)
    assert (response.status_code, error_code(response)) == (403, "FORBIDDEN")
    assert world.storage.presigned == []


def test_upload_request_is_validated(api: WorkspaceApi, setup: Setup) -> None:
    bad_bodies: list[dict[str, Any]] = [
        {"files": []},
        {"files": [file_spec(name="../etc/passwd")]},
        {"files": [file_spec(name="a b.pdf")]},
        {"files": [file_spec(name=".")]},
        {"files": [file_spec(name="..")]},
        {"files": [file_spec(name="...")]},
        {"files": [file_spec(size_bytes=0)]},
        {"files": [file_spec(size_bytes=5 * 1024**3 + 1)]},
        {"files": [file_spec(sha256="ABC")]},
        {"files": [file_spec(), file_spec()]},  # duplicate names
        {"files": [file_spec(name=f"f{i}.csv") for i in range(21)]},
        {"title": ""},
        {"title": "   "},
        {"title": "a\u0000b"},
        {"title": "x" * 301},
        {"access_level": "TOP_SECRET"},
        {"surprise": True},
    ]
    for extra in bad_bodies:
        response = start(api, setup.project_id, **extra)
        assert (response.status_code, error_code(response)) == (422, "VALIDATION_FAILED"), extra


# ---------------------------------------------------------------- inherited access level


def test_no_inputs_means_internal_is_the_loosest_level(api: WorkspaceApi, setup: Setup) -> None:
    response = start(api, setup.project_id, "PUBLIC")
    assert (response.status_code, error_code(response)) == (422, "VALIDATION_FAILED")
    assert response.json()["error"]["details"]["field"] == "access_level"
    for level in ("INTERNAL", "CONTROLLED", "SENSITIVE"):
        assert start(api, setup.project_id, level).status_code == 201, level


def test_access_level_may_not_be_looser_than_the_strictest_input(
    api: WorkspaceApi, setup: Setup, world: World
) -> None:
    world.grants.grant(USERS["a.researcher"], setup.controlled.dataset_id)
    pin(api, setup.project_id, setup.public)
    pin(api, setup.project_id, setup.controlled)
    for level in ("PUBLIC", "INTERNAL"):
        response = start(api, setup.project_id, level)
        assert (response.status_code, error_code(response)) == (422, "VALIDATION_FAILED"), level
        details = response.json()["error"]["details"]
        assert (details["field"], details["minimum"]) == ("access_level", "CONTROLLED")
    for level in ("CONTROLLED", "SENSITIVE"):
        assert start(api, setup.project_id, level).status_code == 201, level


def test_public_inputs_allow_a_public_output(api: WorkspaceApi, setup: Setup) -> None:
    pin(api, setup.project_id, setup.public)
    assert start(api, setup.project_id, "PUBLIC").status_code == 201


def test_dotted_names_that_are_not_only_dots_are_fine(api: WorkspaceApi, setup: Setup) -> None:
    assert start(api, setup.project_id, files=[file_spec(name=".hidden")]).status_code == 201
    assert start(api, setup.project_id, files=[file_spec(name="a..b.csv")]).status_code == 201


def test_complete_rechecks_the_floor_against_current_catalog_levels(
    api: WorkspaceApi, setup: Setup, world: World, db: PgUrls
) -> None:
    pin(api, setup.project_id, setup.public)
    session = start(api, setup.project_id, "PUBLIC")
    assert session.status_code == 201, session.text
    output_id = session.json()["output_id"]
    world.storage.put("inst-a", key(setup.project_id, output_id), REPORT)
    world.catalog.set_access_level(
        setup.public.dataset_id, "CONTROLLED"
    )  # tightened after the session started
    response = api.post("a.researcher", f"/projects/{setup.project_id}/outputs/{output_id}/complete")
    assert (response.status_code, error_code(response)) == (422, "VALIDATION_FAILED")
    details = response.json()["error"]["details"]
    assert (details["field"], details["minimum"]) == ("access_level", "CONTROLLED")
    assert outbox(db) == [e for e in outbox(db) if e["event_type"] != "workspace.output.created.v1"]
    [row] = sql(db, "SELECT status FROM workspace.outputs WHERE output_id = :o", o=output_id)
    assert row["status"] == "UPLOADING"
    # a level that still satisfies the floor completes
    world.catalog.set_access_level(setup.public.dataset_id, "PUBLIC")
    done = api.post("a.researcher", f"/projects/{setup.project_id}/outputs/{output_id}/complete")
    assert done.status_code == 200, done.text


# ---------------------------------------------------------------- completion


def test_complete_verifies_and_creates_the_output_with_lineage(
    api: WorkspaceApi, setup: Setup, world: World, db: PgUrls
) -> None:
    world.grants.grant(USERS["a.researcher"], setup.controlled.dataset_id)
    controlled_input = pin(api, setup.project_id, setup.controlled)
    with clock.frozen(T):
        session = start(api, setup.project_id, "CONTROLLED").json()
    output_id = session["output_id"]
    world.storage.put("inst-a", key(setup.project_id, output_id), REPORT)

    with clock.frozen(T + timedelta(minutes=5)):
        response = api.post("a.researcher", f"/projects/{setup.project_id}/outputs/{output_id}/complete")
    assert response.status_code == 200, response.text
    assert_matches_response("completeOutputUpload", 200, response.json())
    output = response.json()
    assert output["kind"] == "FILE"
    assert output["access_level"] == "CONTROLLED"
    assert output["produced_by_run_id"] is None
    assert output["publish_status"] == "NONE"
    assert output["created_by"] == str(USERS["a.researcher"].user_id)
    assert output["files"] == [file_spec()]
    assert output["lineage"] == {
        "inputs": [
            {
                "dataset_id": str(setup.controlled.dataset_id),
                "dataset_title": "이차전지 충방전 측정",
                "dataset_version_id": controlled_input["dataset_version_id"],
                "version_label": "v2",
            }
        ],
        "recipe_id": None,
        "recipe_version": None,
        "run_id": None,
    }
    assert world.storage.hashed == [("inst-a", key(setup.project_id, output_id))]

    events = [e for e in outbox(db) if e["event_type"] == "workspace.output.created.v1"]
    [event] = events
    assert_valid_event(event)
    assert event["payload"] | {"occurred_at": None} == {
        "project_id": str(setup.project_id),
        "actor_id": str(USERS["a.researcher"].user_id),
        "occurred_at": None,
        "output_id": output_id,
        "output_title": "분석 보고서 초안",
        "kind": "FILE",
        "access_level": "CONTROLLED",
        "run_id": None,
        "lineage_dataset_version_ids": [controlled_input["dataset_version_id"]],
    }

    # completing again is a no-op that returns the same output
    again = api.post("a.researcher", f"/projects/{setup.project_id}/outputs/{output_id}/complete")
    assert again.status_code == 200 and again.json() == output
    assert len([e for e in outbox(db) if e["event_type"] == "workspace.output.created.v1"]) == 1

    got = api.get("a.viewer", f"/projects/{setup.project_id}/outputs/{output_id}")
    assert got.status_code == 200, got.text
    assert_matches_response("getOutput", 200, got.json())
    assert got.json() == output


def test_checksum_mismatch_is_rejected(api: WorkspaceApi, setup: Setup, world: World, db: PgUrls) -> None:
    output_id = start(api, setup.project_id).json()["output_id"]
    path = f"/projects/{setup.project_id}/outputs/{output_id}/complete"

    missing = api.post("a.researcher", path)
    assert (missing.status_code, error_code(missing)) == (422, "UPLOAD_CHECKSUM_MISMATCH")

    world.storage.put("inst-a", key(setup.project_id, output_id), REPORT + b"!")  # wrong size
    wrong_size = api.post("a.researcher", path)
    assert (wrong_size.status_code, error_code(wrong_size)) == (422, "UPLOAD_CHECKSUM_MISMATCH")
    assert wrong_size.json()["error"]["details"]["files"] == [
        {"name": "report.pdf", "reason": "SIZE_MISMATCH"}
    ]
    assert world.storage.hashed == []  # size is checked before the (expensive) hash

    tampered = bytes(reversed(REPORT))  # same size, other content
    world.storage.put("inst-a", key(setup.project_id, output_id), tampered)
    wrong_hash = api.post("a.researcher", path)
    assert (wrong_hash.status_code, error_code(wrong_hash)) == (422, "UPLOAD_CHECKSUM_MISMATCH")
    assert wrong_hash.json()["error"]["details"]["files"] == [
        {"name": "report.pdf", "reason": "SHA256_MISMATCH"}
    ]

    assert outbox(db) == []
    assert api.get("a.researcher", f"/projects/{setup.project_id}/outputs").json()["items"] == []

    world.storage.put("inst-a", key(setup.project_id, output_id), REPORT)  # a corrected re-upload completes
    assert api.post("a.researcher", path).status_code == 200


def test_only_the_uploader_completes_a_live_session(
    api: WorkspaceApi, setup: Setup, world: World, db: PgUrls
) -> None:
    with clock.frozen(T):
        output_id = start(api, setup.project_id).json()["output_id"]
    world.storage.put("inst-a", key(setup.project_id, output_id), REPORT)
    path = f"/projects/{setup.project_id}/outputs/{output_id}/complete"

    other = api.post("a.owner", path)
    assert (other.status_code, error_code(other)) == (403, "FORBIDDEN")
    outsider = api.post("a.outsider", path)
    assert outsider.status_code == 404
    assert (
        api.post("a.researcher", f"/projects/{setup.project_id}/outputs/{new_id()}/complete").status_code
        == 404
    )

    with clock.frozen(T + timedelta(minutes=15, seconds=1)):
        expired = api.post("a.researcher", path)
    assert (expired.status_code, error_code(expired)) == (409, "UPLOAD_SESSION_EXPIRED")
    assert outbox(db) == []


def test_archived_project_cannot_complete(api: WorkspaceApi, setup: Setup, world: World) -> None:
    output_id = start(api, setup.project_id).json()["output_id"]
    world.storage.put("inst-a", key(setup.project_id, output_id), REPORT)
    world.projects.archived.add(setup.project_id)
    response = api.post("a.researcher", f"/projects/{setup.project_id}/outputs/{output_id}/complete")
    assert (response.status_code, error_code(response)) == (403, "FORBIDDEN")


def test_multiple_files_are_all_verified(api: WorkspaceApi, setup: Setup, world: World) -> None:
    data = b"a,b\n1,2\n"
    files = [file_spec(), file_spec(name="table.csv", data=data, media_type="text/csv")]
    output_id = start(api, setup.project_id, files=files).json()["output_id"]
    world.storage.put("inst-a", key(setup.project_id, output_id), REPORT)
    path = f"/projects/{setup.project_id}/outputs/{output_id}/complete"
    partial = api.post("a.researcher", path)
    assert partial.json()["error"]["details"]["files"] == [{"name": "table.csv", "reason": "MISSING"}]
    world.storage.put("inst-a", key(setup.project_id, output_id, "table.csv"), data)
    done = api.post("a.researcher", path)
    assert done.status_code == 200
    assert [f["name"] for f in done.json()["files"]] == ["report.pdf", "table.csv"]


# ---------------------------------------------------------------- reads


def test_list_outputs_newest_first_with_paging_and_kind_filter(
    api: WorkspaceApi, setup: Setup, world: World
) -> None:
    created = []
    for minute in range(3):
        with clock.frozen(T + timedelta(minutes=minute)):
            created.append(uploaded(api, world, setup.project_id)["output_id"])
    path = f"/projects/{setup.project_id}/outputs"
    first = api.get("a.viewer", f"{path}?limit=2")
    assert first.status_code == 200, first.text
    assert_matches_response("listOutputs", 200, first.json())
    assert [o["output_id"] for o in first.json()["items"]] == created[:0:-1]
    cursor = first.json()["page"]["next_cursor"]
    second = api.get("a.viewer", f"{path}?limit=2&cursor={cursor}").json()
    assert [o["output_id"] for o in second["items"]] == [created[0]]
    assert second["page"]["has_more"] is False
    assert len(api.get("a.viewer", f"{path}?kind=FILE").json()["items"]) == 3
    assert api.get("a.viewer", f"{path}?kind=DERIVED_DATASET").json()["items"] == []


def test_non_members_do_not_see_outputs(api: WorkspaceApi, setup: Setup, world: World) -> None:
    output_id = uploaded(api, world, setup.project_id)["output_id"]
    assert api.get("a.outsider", f"/projects/{setup.project_id}/outputs").status_code == 404
    assert api.get("a.outsider", f"/projects/{setup.project_id}/outputs/{output_id}").status_code == 404
    other_project = new_id()
    world.projects.add(other_project, USERS["a.researcher"], "RESEARCHER")
    assert api.get("a.researcher", f"/projects/{other_project}/outputs/{output_id}").status_code == 404


# ---------------------------------------------------------------- download


def test_member_downloads_with_short_lived_urls(api: WorkspaceApi, setup: Setup, world: World) -> None:
    output = uploaded(api, world, setup.project_id)
    world.projects.archived.add(setup.project_id)  # downloads stay available for an archived project
    with clock.frozen(T):
        response = api.post(
            "a.viewer", f"/projects/{setup.project_id}/outputs/{output['output_id']}/download"
        )
    assert response.status_code == 201, response.text
    assert_matches_response("getOutputDownload", 201, response.json())
    body = response.json()
    assert body["expires_at"].replace("Z", "+00:00") == (T + timedelta(seconds=300)).isoformat()
    assert body["files"] == [
        {
            "name": "report.pdf",
            "url": f"http://storage.test/inst-a/{key(setup.project_id, output['output_id'])}?sig=get",
            "size_bytes": len(REPORT),
            "sha256": hashlib.sha256(REPORT).hexdigest(),
        }
    ]
    assert world.storage.presigned[-1] == ("GET", "inst-a", key(setup.project_id, output["output_id"]), 300)


def test_non_member_cannot_download(api: WorkspaceApi, setup: Setup, world: World) -> None:
    output_id = uploaded(api, world, setup.project_id)["output_id"]
    response = api.post("a.outsider", f"/projects/{setup.project_id}/outputs/{output_id}/download")
    assert (response.status_code, error_code(response)) == (403, "FORBIDDEN")
    unknown = api.post("a.researcher", f"/projects/{setup.project_id}/outputs/{new_id()}/download")
    assert unknown.status_code == 404


def test_session_cannot_be_downloaded_before_completion(api: WorkspaceApi, setup: Setup) -> None:
    output_id = start(api, setup.project_id).json()["output_id"]
    response = api.post("a.researcher", f"/projects/{setup.project_id}/outputs/{output_id}/download")
    assert response.status_code == 404


def test_download_is_blocked_when_a_lineage_input_lapsed(
    api: WorkspaceApi, setup: Setup, world: World, db: PgUrls
) -> None:
    researcher = USERS["a.researcher"]
    world.grants.grant(researcher, setup.controlled.dataset_id)
    controlled_input = pin(api, setup.project_id, setup.controlled)
    pin(api, setup.project_id, setup.public)
    output_id = uploaded(api, world, setup.project_id, "CONTROLLED")["output_id"]
    path = f"/projects/{setup.project_id}/outputs/{output_id}/download"
    assert api.post("a.researcher", path).status_code == 201

    world.grants.revoke(researcher, setup.controlled.dataset_id)
    lapsed = api.post("a.researcher", path)
    assert (lapsed.status_code, error_code(lapsed)) == (409, "INPUT_ACCESS_LAPSED")
    assert lapsed.json()["error"]["details"]["input_ids"] == [controlled_input["input_id"]]
    # a member without a grant of their own is blocked too
    assert error_code(api.post("a.owner", path)) == "INPUT_ACCESS_LAPSED"
    # metadata stays readable
    assert api.get("a.researcher", f"/projects/{setup.project_id}/outputs/{output_id}").status_code == 200


# ---------------------------------------------------------------- discussions on outputs


def test_output_threads_belong_to_the_output_project(api: WorkspaceApi, setup: Setup, world: World) -> None:
    session_id = start(api, setup.project_id).json()["output_id"]
    output_id = uploaded(api, world, setup.project_id)["output_id"]
    body = {"scope": "OUTPUT", "target_id": output_id, "title": "단위 확인", "body": "표 2의 단위?"}
    response = api.post("a.viewer", "/threads", json=body)
    assert response.status_code == 201, response.text
    assert response.json()["project_id"] == str(setup.project_id)
    assert api.post("a.outsider", "/threads", json=body).status_code == 404
    pending = api.post("a.researcher", "/threads", json=body | {"target_id": session_id})
    assert pending.status_code == 404  # an unfinished upload is not a discussable output
    listed = api.get("a.researcher", f"/threads?scope=OUTPUT&target_id={output_id}")
    assert [t["title"] for t in listed.json()["items"]] == ["단위 확인"]


def test_database_rejects_inconsistent_output_rows(db: PgUrls) -> None:
    """A READY output has created_at; an UPLOADING one has none (ck_outputs_ready)."""
    with pytest.raises(Exception, match="ck_outputs_ready"):
        sql(
            db,
            "INSERT INTO workspace.outputs (output_id, project_id, kind, title, access_level, status,"
            " created_by, started_at) VALUES (:o, :p, 'FILE', 't', 'INTERNAL', 'READY', :u, now())",
            o=new_id(),
            p=new_id(),
            u=new_id(),
        )
