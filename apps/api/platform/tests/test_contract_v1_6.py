"""Contract 1.6.0: Data-Hub, project workspace and research notes (spec 2026-10-02-data-hub-workspace-notes-design)."""

import json
import re
from typing import Any

import pytest
import yaml

from api.platform.generated.error_codes import HTTP_STATUS, ErrorCode
from api.platform.generated.event_types import PRODUCER, EventType
from api.platform.settings import Settings
from api.platform.testing.contracts import assert_matches_response, assert_valid_event

CONTRACTS = Settings().contracts_dir
NEW_OPS: dict[str, tuple[str, str, str]] = {
    # hub
    "getHubOverview": ("get", "/hub/overview", "hub"),
    "listDatasetProjects": ("get", "/datasets/{dataset_id}/projects", "hub"),
    "listDatasetActivity": ("get", "/datasets/{dataset_id}/activity", "hub"),
    # workspace: inputs
    "listProjectInputs": ("get", "/projects/{project_id}/inputs", "workspace"),
    "addProjectInput": ("post", "/projects/{project_id}/inputs", "workspace"),
    "updateProjectInput": ("patch", "/projects/{project_id}/inputs/{input_id}", "workspace"),
    "removeProjectInput": ("delete", "/projects/{project_id}/inputs/{input_id}", "workspace"),
    # workspace: recipes and runs
    "listRecipes": ("get", "/projects/{project_id}/recipes", "workspace"),
    "createRecipe": ("post", "/projects/{project_id}/recipes", "workspace"),
    "getRecipe": ("get", "/projects/{project_id}/recipes/{recipe_id}", "workspace"),
    "updateRecipe": ("put", "/projects/{project_id}/recipes/{recipe_id}", "workspace"),
    "deleteRecipe": ("delete", "/projects/{project_id}/recipes/{recipe_id}", "workspace"),
    "previewRecipe": ("post", "/projects/{project_id}/recipes/{recipe_id}/preview", "workspace"),
    "startRun": ("post", "/projects/{project_id}/recipes/{recipe_id}/runs", "workspace"),
    "listRuns": ("get", "/projects/{project_id}/runs", "workspace"),
    "getRun": ("get", "/projects/{project_id}/runs/{run_id}", "workspace"),
    # workspace: outputs and hub publication
    "listOutputs": ("get", "/projects/{project_id}/outputs", "workspace"),
    "createOutputUpload": ("post", "/projects/{project_id}/outputs", "workspace"),
    "completeOutputUpload": ("post", "/projects/{project_id}/outputs/{output_id}/complete", "workspace"),
    "getOutput": ("get", "/projects/{project_id}/outputs/{output_id}", "workspace"),
    "getOutputDownload": ("post", "/projects/{project_id}/outputs/{output_id}/download", "workspace"),
    "requestOutputPublish": (
        "post",
        "/projects/{project_id}/outputs/{output_id}/publish-requests",
        "workspace",
    ),
    "listPublishRequests": ("get", "/publish-requests", "workspace"),
    "decidePublishRequest": ("post", "/publish-requests/{request_id}/decision", "workspace"),
    # workspace: discussion
    "listThreads": ("get", "/threads", "workspace"),
    "createThread": ("post", "/threads", "workspace"),
    "updateThread": ("patch", "/threads/{thread_id}", "workspace"),
    "listComments": ("get", "/threads/{thread_id}/comments", "workspace"),
    "addComment": ("post", "/threads/{thread_id}/comments", "workspace"),
    # notes
    "listNotes": ("get", "/notes", "notes"),
    "getOrCreateTodayNote": ("post", "/projects/{project_id}/notes/today", "notes"),
    "getNote": ("get", "/notes/{note_id}", "notes"),
    "deleteNote": ("delete", "/notes/{note_id}", "notes"),
    "updateNoteBlocks": ("put", "/notes/{note_id}/blocks", "notes"),
    "draftNote": ("post", "/notes/{note_id}/draft", "notes"),
    "submitNote": ("post", "/notes/{note_id}/submit", "notes"),
    "rejectNote": ("post", "/notes/{note_id}/reject", "notes"),
    "signNote": ("post", "/notes/{note_id}/sign", "notes"),
    "reviseNote": ("post", "/notes/{note_id}/revise", "notes"),
    "verifyNote": ("get", "/notes/{note_id}/verify", "notes"),
    "exportNotes": ("get", "/notes/export", "notes"),
    "searchNotes": ("get", "/notes/search", "notes"),
    "getNoteSettings": ("get", "/projects/{project_id}/note-settings", "notes"),
    "updateNoteSettings": ("patch", "/projects/{project_id}/note-settings", "notes"),
}
NEW_ERRORS = {
    "ACCESS_REQUIRED": 403,
    "INPUT_ACCESS_LAPSED": 409,
    "RECIPE_INVALID": 422,
    "RUN_NOT_ALLOWED": 409,
    "OUTPUT_PUBLISH_PENDING": 409,
    "NOTE_LOCKED": 409,
    "NOTE_HAS_UNACCEPTED_AI": 409,
    "NOTE_SIGNATURE_EXPIRED": 401,
    "NOTE_NOT_WITNESS": 403,
    "LLM_UNAVAILABLE": 503,
    "RATE_LIMITED": 429,
}
# Operations that must declare the status their documented error code maps to.
ERROR_STATUS_DECLARED = {
    "addProjectInput": "403",  # ACCESS_REQUIRED
    "startRun": "409",  # INPUT_ACCESS_LAPSED, RUN_NOT_ALLOWED
    "previewRecipe": "409",  # INPUT_ACCESS_LAPSED
    "getOutputDownload": "409",  # INPUT_ACCESS_LAPSED
    "createRecipe": "422",  # RECIPE_INVALID
    "updateRecipe": "422",  # RECIPE_INVALID
    "requestOutputPublish": "409",  # OUTPUT_PUBLISH_PENDING
    "updateNoteBlocks": "409",  # NOTE_LOCKED
    "submitNote": "409",  # NOTE_HAS_UNACCEPTED_AI
    "signNote": "401",  # NOTE_SIGNATURE_EXPIRED
    "rejectNote": "403",  # NOTE_NOT_WITNESS
    "draftNote": "503",  # LLM_UNAVAILABLE
    "deleteNote": "409",  # NOTE_LOCKED
}
ID = "00000000-0000-7000-8000-00000000{:04x}"
COMMON = {"project_id": ID.format(1), "actor_id": ID.format(2), "occurred_at": "2026-10-02T01:00:00Z"}
HASH = "a" * 64
INPUT = {
    "input_id": ID.format(10),
    "dataset_id": ID.format(11),
    "dataset_title": "이차전지 충방전 측정",
    "dataset_version_id": ID.format(12),
    "version_label": "v1",
    "owner_organization_id": ID.format(13),
}
NOTE = {
    "note_id": ID.format(20),
    "note_date": "2026-10-02",
    "version": 1,
    "recorder_id": ID.format(2),
    "organization_id": ID.format(21),
}
EVENTS: dict[str, dict[str, Any]] = {
    "workspace.input.added.v1": {**COMMON, **INPUT},
    "workspace.input.version_changed.v1": {
        **COMMON,
        **INPUT,
        "previous_dataset_version_id": ID.format(14),
        "previous_version_label": "v0",
    },
    "workspace.input.removed.v1": {**COMMON, **INPUT},
    "workspace.recipe.saved.v1": {
        **COMMON,
        "recipe_id": ID.format(30),
        "recipe_name": "고온 구간 평균 용량",
        "recipe_version": 2,
        "input_ids": [ID.format(10)],
        "step_count": 3,
    },
    "workspace.run.succeeded.v1": {
        **COMMON,
        "run_id": ID.format(31),
        "recipe_id": ID.format(30),
        "recipe_name": "고온 구간 평균 용량",
        "recipe_version": 2,
        "input_rows": 1000,
        "output_rows": 24,
        "output_id": ID.format(32),
    },
    "workspace.run.failed.v1": {
        **COMMON,
        "run_id": ID.format(31),
        "recipe_id": ID.format(30),
        "recipe_name": "고온 구간 평균 용량",
        "recipe_version": 2,
        "error": "column temperature_c not found",
    },
    "workspace.output.created.v1": {
        **COMMON,
        "output_id": ID.format(32),
        "output_title": "고온 구간 평균 용량",
        "kind": "DERIVED_DATASET",
        "access_level": "CONTROLLED",
        "run_id": ID.format(31),
        "lineage_dataset_version_ids": [ID.format(12)],
    },
    "workspace.publish.requested.v1": {
        **COMMON,
        "request_id": ID.format(40),
        "output_id": ID.format(32),
        "output_title": "고온 구간 평균 용량",
        "project_name": "전극 소재 열화 분석",
        "approver_organization_ids": [ID.format(13)],
    },
    "workspace.publish.decided.v1": {
        **COMMON,
        "request_id": ID.format(40),
        "output_id": ID.format(32),
        "output_title": "고온 구간 평균 용량",
        "organization_id": ID.format(13),
        "decision": "APPROVE",
        "request_status": "APPROVED",
        "requested_by": ID.format(2),
        "published_dataset_id": ID.format(41),
    },
    "workspace.comment.added.v1": {
        **COMMON,
        "project_id": None,
        "thread_id": ID.format(50),
        "thread_title": "온도 단위 확인 요청",
        "scope": "DATASET",
        "target_id": ID.format(11),
        "comment_id": ID.format(51),
        "new_thread": True,
        "owner_organization_id": ID.format(13),
    },
    "notes.note.submitted.v1": {
        **COMMON,
        **NOTE,
        "project_name": "전극 소재 열화 분석",
        "witness_user_ids": [ID.format(3)],
        "content_hash": HASH,
    },
    "notes.note.signed.v1": {
        **COMMON,
        **NOTE,
        "project_name": "전극 소재 열화 분석",
        "signer_id": ID.format(3),
        "signer_role": "WITNESS",
        "final": True,
        "content_hash": HASH,
        "chain_hash": "b" * 64,
    },
    "notes.note.rejected.v1": {
        **COMMON,
        **NOTE,
        "project_name": "전극 소재 열화 분석",
        "reason": "결과 섹션 근거를 보완해 주세요.",
    },
    "notes.note.viewed.v1": {**COMMON, **NOTE, "status": "SIGNED"},
}


def _spec() -> dict[str, Any]:
    spec: dict[str, Any] = yaml.safe_load((CONTRACTS / "openapi.yaml").read_text("utf-8"))
    return spec


def _envelope(event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "event_id": ID.format(0xF001),
        "event_type": event_type,
        "occurred_at": "2026-10-02T01:00:00Z",
        "producer": event_type.split(".", 1)[0],
        "correlation_id": ID.format(0xF002),
        "actor": {"type": "USER", "user_id": ID.format(2), "organization_id": ID.format(21)},
        "payload": payload,
    }


def test_version_tags_and_new_operations() -> None:
    spec = _spec()
    major, minor, *_ = (int(x) for x in spec["info"]["version"].split("."))
    assert (major, minor) >= (1, 6)  # later contracts (1.7 merges Stage 2 versioning) keep these operations
    assert {"hub", "workspace", "notes"} <= {t["name"] for t in spec["tags"]}
    assert len(NEW_OPS) == 44
    for op_id, (method, path, tag) in NEW_OPS.items():
        op = spec["paths"][path][method]
        assert op["operationId"] == op_id
        assert op["tags"] == [tag], op_id
        assert "security" not in op, op_id  # inherits bearerAuth
        assert op["responses"]["401"] == {"$ref": "#/components/responses/Error"}, op_id


@pytest.mark.parametrize(("op_id", "status"), sorted(ERROR_STATUS_DECLARED.items()))
def test_documented_error_statuses_are_declared(op_id: str, status: str) -> None:
    method, path, _ = NEW_OPS[op_id]
    assert _spec()["paths"][path][method]["responses"][status] == {"$ref": "#/components/responses/Error"}


def test_optimistic_concurrency_uses_if_match() -> None:
    spec = _spec()
    for op_id in ("updateRecipe", "updateNoteBlocks"):
        method, path, _ = NEW_OPS[op_id]
        params = spec["paths"][path][method]["parameters"]
        assert {"$ref": "#/components/parameters/IfMatch"} in params, op_id
    assert spec["components"]["parameters"]["IfMatch"]["in"] == "header"


def test_success_examples_match_their_response_schema() -> None:
    spec = _spec()
    checked = 0
    for op_id, (method, path, _) in NEW_OPS.items():
        for status, response in spec["paths"][path][method]["responses"].items():
            content = response.get("content", {}).get("application/json")
            if content is None:
                continue
            examples = content.get("examples")
            assert examples, f"{op_id} {status} has no example"
            for example in examples.values():
                name = example["$ref"].rsplit("/", 1)[1]
                assert_matches_response(op_id, int(status), spec["components"]["examples"][name]["value"])
                checked += 1
    assert checked >= 41


def test_export_notes_is_a_zip_download() -> None:
    method, path, _ = NEW_OPS["exportNotes"]
    ok = _spec()["paths"][path][method]["responses"]["200"]
    assert set(ok["content"]) == {"application/zip"}
    assert ok["content"]["application/zip"]["schema"] == {"type": "string", "format": "binary"}


def test_note_settings_llm_enabled_is_read_only() -> None:
    schemas = _spec()["components"]["schemas"]
    assert schemas["NoteSettings"]["properties"]["llm_enabled"]["readOnly"] is True
    assert "llm_enabled" not in schemas["NoteSettingsUpdate"]["properties"]
    assert schemas["NoteSettingsUpdate"]["additionalProperties"] is False


def test_recipe_step_is_a_discriminated_union_of_ten_kinds() -> None:
    schemas = _spec()["components"]["schemas"]
    step = schemas["RecipeStep"]
    kinds = schemas["RecipeStepType"]["enum"]
    assert step["discriminator"]["propertyName"] == "type"
    assert list(step["discriminator"]["mapping"]) == kinds
    assert len(step["oneOf"]) == len(kinds) == 10
    for kind, ref in step["discriminator"]["mapping"].items():
        variant = schemas[ref.rsplit("/", 1)[1]]
        assert variant["properties"]["type"] == {"const": kind}
        assert variant["additionalProperties"] is False


def test_generated_models_parse_a_recipe_and_keep_integers() -> None:
    from nais_contracts.api_models import RecipeStepFilterRows, RecipeWrite

    recipe = RecipeWrite.model_validate(
        {
            "name": "r",
            "input_ids": [ID.format(10)],
            "steps": [
                {"type": "filter_rows", "column": "c", "op": "in", "value": [1, "a"]},
                {"type": "join", "right_input_id": ID.format(10), "on": ["k"], "how": "left"},
                {"type": "limit", "n": 10},
            ],
        }
    )
    first = recipe.steps[0].root
    assert isinstance(first, RecipeStepFilterRows)
    assert recipe.model_dump(mode="json")["steps"][0]["value"] == [1, "a"]


def test_new_error_codes_are_registered_and_generated() -> None:
    codes = {c["code"]: c for c in json.loads((CONTRACTS / "error_codes.json").read_text("utf-8"))["codes"]}
    for code, http in NEW_ERRORS.items():
        assert codes[code]["http"] == http, code
        assert HTTP_STATUS[ErrorCode(code)] == http, code


def test_new_events_are_registered_and_validate() -> None:
    index = {
        e["event_type"]: e["producer"]
        for e in json.loads((CONTRACTS / "events" / "index.json").read_text("utf-8"))["events"]
    }
    assert len(EVENTS) == 14
    for event_type, payload in EVENTS.items():
        producer = event_type.split(".", 1)[0]
        assert index[event_type] == producer
        assert PRODUCER[EventType(event_type)] == producer
        assert_valid_event(_envelope(event_type, payload))


def test_event_payloads_carry_project_actor_and_time() -> None:
    schema = json.loads((CONTRACTS / "events" / "p0_events.schema.json").read_text("utf-8"))
    variants = {v["properties"]["event_type"]["const"]: v for v in schema["oneOf"]}
    for event_type in EVENTS:
        required = variants[event_type]["properties"]["payload"]["required"]
        assert {"project_id", "actor_id", "occurred_at"} <= set(required), event_type


def test_event_payloads_reject_unknown_fields() -> None:
    with pytest.raises(AssertionError):
        assert_valid_event(
            _envelope("notes.note.viewed.v1", {**EVENTS["notes.note.viewed.v1"], "blocks": []})
        )


def test_audit_and_notification_enums_cover_the_new_events() -> None:
    schemas = _spec()["components"]["schemas"]
    assert {
        "PROJECT_INPUT",
        "RECIPE",
        "RUN",
        "OUTPUT",
        "PUBLISH_REQUEST",
        "THREAD",
        "RESEARCH_NOTE",
    } <= set(schemas["ResourceType"]["enum"])
    actions = set(schemas["AuditAction"]["enum"])
    assert {
        "PROJECT_INPUT_ADDED",
        "PROJECT_INPUT_VERSION_CHANGED",
        "PROJECT_INPUT_REMOVED",
        "RECIPE_SAVED",
        "RUN_SUCCEEDED",
        "RUN_FAILED",
        "OUTPUT_CREATED",
        "OUTPUT_PUBLISH_REQUESTED",
        "OUTPUT_PUBLISH_DECIDED",
        "COMMENT_ADDED",
        "NOTE_SUBMITTED",
        "NOTE_SIGNED",
        "NOTE_REJECTED",
        "NOTE_VIEWED",
    } <= actions
    assert {
        "OUTPUT_PUBLISH_REQUESTED",
        "OUTPUT_PUBLISH_DECIDED",
        "NOTE_SUBMITTED",
        "NOTE_REJECTED",
        "NOTE_SIGNED",
        "DATASET_COMMENT_ADDED",
        "RUN_FAILED",
    } <= set(schemas["NotificationType"]["enum"])


def test_module_ownership_and_db_schemas() -> None:
    ownership = json.loads((CONTRACTS / "module_ownership.json").read_text("utf-8"))
    assert ownership["M13"]["db_schema"] == "workspace"
    assert ownership["M13"]["path"] == ["apps/api/modules/workspace"]
    assert ownership["M14"]["db_schema"] == "notes"
    assert ownership["M14"]["path"] == ["apps/api/modules/notes"]
    init_sql = (CONTRACTS.parents[1] / "infra" / "docker" / "postgres" / "init.sql").read_text("utf-8")
    match = re.search(r"FOREACH\s+s\s+IN\s+ARRAY\s+ARRAY\[(.*?)\]\s+LOOP", init_sql, re.S)
    assert match is not None
    schemas = set(re.findall(r"'([a-z_]+)'", match.group(1)))
    assert {"workspace", "notes"} <= schemas
    owned = {
        spec["db_schema"] for spec in ownership.values() if isinstance(spec, dict) and spec.get("db_schema")
    }
    assert owned <= schemas


RECORDER_ONLY_NOTE_OPS = ("deleteNote", "updateNoteBlocks", "draftNote", "submitNote", "reviseNote")


@pytest.mark.parametrize("op_id", RECORDER_ONLY_NOTE_OPS)
def test_recorder_only_note_operations_split_403_and_404(op_id: str) -> None:
    method, path, _ = NEW_OPS[op_id]
    op = _spec()["paths"][path][method]
    for status in ("403", "404", "409"):
        assert op["responses"][status] == {"$ref": "#/components/responses/Error"}, (op_id, status)
    assert "403 FORBIDDEN otherwise" in op["description"], op_id


def test_delete_note_is_draft_only_and_returns_204() -> None:
    op = _spec()["paths"]["/notes/{note_id}"]["delete"]
    assert op["responses"]["204"] == {"description": "Deleted"}
    assert "DRAFT only" in op["description"] and "NOTE_LOCKED" in op["description"]


def test_witness_rules_use_the_snapshot_taken_at_submit() -> None:
    spec = _spec()
    note = spec["components"]["schemas"]["ResearchNote"]
    for field in ("witness_required", "witness_user_ids"):
        assert field in note["required"], field
        assert note["properties"][field]["readOnly"] is True, field
    sign = spec["paths"]["/notes/{note_id}/sign"]["post"]["description"]
    assert "from SUBMITTED in every case" in sign
    assert "never the current project setting" in sign
    assert "snapshot" in spec["paths"]["/notes/{note_id}/submit"]["post"]["description"]
    assert "snapshot" in spec["paths"]["/projects/{project_id}/note-settings"]["patch"]["description"]


def test_export_excludes_other_drafts_and_records_views() -> None:
    description = _spec()["paths"]["/notes/export"]["get"]["description"]
    assert "never other recorders' DRAFTs" in description
    assert "notes.note.viewed.v1" in description


def test_reject_example_carries_the_reason() -> None:
    example = _spec()["components"]["examples"]["ResearchNoteRejected"]["value"]
    assert example["status"] == "DRAFT" and example["rejected_reason"]
    assert_matches_response("rejectNote", 200, example)


def test_comment_added_project_id_depends_on_scope() -> None:
    dataset = EVENTS["workspace.comment.added.v1"]
    project = {**dataset, "scope": "PROJECT", "target_id": ID.format(1), "project_id": ID.format(1)}
    assert_valid_event(_envelope("workspace.comment.added.v1", project))
    with pytest.raises(AssertionError):
        assert_valid_event(_envelope("workspace.comment.added.v1", {**project, "project_id": None}))
    with pytest.raises(AssertionError):
        assert_valid_event(_envelope("workspace.comment.added.v1", {**dataset, "project_id": ID.format(1)}))
