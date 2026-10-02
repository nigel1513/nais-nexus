import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { checkResponse } from "../../tests/contract";
import { DATASET, ORG, sid, USER, VERSION } from "./fixtures";

type Doc = { paths: Record<string, Record<string, { operationId: string }>> };
const doc = YAML.parse(readFileSync(path.resolve(process.cwd(), "../../NAIS_PRD/contracts/openapi.yaml"), "utf8")) as Doc;

const exercised = new Set<string>();

// Contract 1.6.0 operations (hub, workspace, research notes) whose mock handlers do not exist yet — implemented in Task 12.
// Task 12 must exercise each of them below and empty this list; an operation listed here that is exercised fails the test.
const PENDING_MOCK_OPERATIONS: ReadonlySet<string> = new Set([
  "getHubOverview", "listDatasetProjects", "listDatasetActivity",
  "listProjectInputs", "addProjectInput", "updateProjectInput", "removeProjectInput",
  "listRecipes", "createRecipe", "getRecipe", "updateRecipe", "deleteRecipe", "previewRecipe",
  "startRun", "listRuns", "getRun",
  "listOutputs", "createOutputUpload", "completeOutputUpload", "getOutput", "getOutputDownload",
  "requestOutputPublish", "listPublishRequests", "decidePublishRequest",
  "listThreads", "createThread", "updateThread", "listComments", "addComment",
  "listNotes", "exportNotes", "searchNotes", "getOrCreateTodayNote", "getNoteSettings", "updateNoteSettings",
  "getNote", "deleteNote", "updateNoteBlocks", "draftNote", "submitNote", "rejectNote", "signNote", "reviseNote", "verifyNote",
]);

async function call(user: string | null, method: string, pathKey: string, opts: { path?: Record<string, string>; query?: string; body?: unknown; status: number }) {
  const url = pathKey.replace(/\{(\w+)\}/g, (_, k: string) => opts.path![k]!) + (opts.query ? `?${opts.query}` : "");
  const res = await fetch(`http://localhost:3000/mock-api/v1${url}`, {
    method: method.toUpperCase(),
    headers: { ...(user ? { "x-mock-user": user } : {}), "content-type": "application/json" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const op = doc.paths[pathKey]![method]!;
  exercised.add(op.operationId);
  const text = await res.text();
  expect(res.status, `${op.operationId}: ${text}`).toBe(opts.status);
  if (opts.status === 204) {
    expect(checkResponse(method, url.split("?")[0]!, 204, null)).toEqual([]);
    return undefined;
  }
  const json = JSON.parse(text);
  expect(checkResponse(method, url.split("?")[0]!, opts.status, json), `${op.operationId} violates openapi`).toEqual([]);
  return json;
}

describe("mock API ↔ openapi.yaml", () => {
  it("exercises every operation and every response matches its schema", async () => {
    const A = USER.aResearcher;
    const AS = USER.aSteward;
    const BS = USER.bSteward;
    const BR = USER.bResearcher;

    await call(null, "get", "/health/live", { status: 200 });
    await call(null, "get", "/health/ready", { status: 200 });
    await call(A, "get", "/me", { status: 200 });
    await call(A, "get", "/users", { query: "q=re", status: 200 });
    await call(A, "get", "/organizations", { status: 200 });
    await call(A, "get", "/organizations/{organization_id}", { path: { organization_id: ORG.a }, status: 200 });
    await call(USER.aAdmin, "get", "/organizations/{organization_id}/members", { path: { organization_id: ORG.a }, status: 200 });
    await call(USER.aAdmin, "patch", "/organizations/{organization_id}/members/{user_id}", { path: { organization_id: ORG.a, user_id: AS }, body: { roles: ["DATA_STEWARD"] }, status: 200 });

    await call(A, "get", "/projects", { status: 200 });
    const p = await call(A, "post", "/projects", { body: { name: "Contract Study", description: "계약 검증" }, status: 201 });
    const P = { project_id: p.project_id as string };
    await call(A, "get", "/projects/{project_id}", { path: P, status: 200 });
    await call(A, "patch", "/projects/{project_id}", { path: P, body: { description: "수정" }, status: 200 });
    await call(A, "get", "/projects/{project_id}/members", { path: P, status: 200 });
    await call(A, "post", "/projects/{project_id}/members", { path: P, body: { user_id: BR, role: "RESEARCHER" }, status: 201 });
    await call(A, "patch", "/projects/{project_id}/members/{user_id}", { path: { ...P, user_id: BR }, body: { role: "VIEWER" }, status: 200 });
    await call(A, "delete", "/projects/{project_id}/members/{user_id}", { path: { ...P, user_id: BR }, status: 204 });

    await call(A, "get", "/datasets", { query: "q=battery&access_level=CONTROLLED", status: 200 });
    const d = await call(AS, "post", "/datasets", {
      body: {
        owner_organization_id: ORG.a,
        title: "Contract Dataset",
        description: "d",
        access_level: "CONTROLLED",
        license: "CC-BY-4.0",
        allowed_purposes: ["ACADEMIC_RESEARCH"],
        principal_investigator_id: A,
        data_steward_contact_id: AS,
        contact_email_public: true,
        subject_codes: ["MATERIALS"],
        temporal_start: "2026-01-01",
        related_publications: [{ title: "Paper", doi: "10.1000/abc" }],
      },
      status: 201,
    });
    const D = { dataset_id: d.dataset_id as string };
    await call(A, "get", "/datasets/{dataset_id}", { path: { dataset_id: DATASET.battery }, status: 200 });
    await call(AS, "patch", "/datasets/{dataset_id}", { path: D, body: { max_grant_days: 90, subtitle: null }, status: 200 });
    await call(A, "get", "/vocabulary/{scheme}", { path: { scheme: "SUBJECT" }, status: 200 });
    await call(USER.admin, "post", "/vocabulary/{scheme}", { path: { scheme: "METHOD" }, body: { code: "CONTRACT_TERM", label_ko: "계약", label_en: "Contract" }, status: 201 });
    await call(AS, "put", "/datasets/{dataset_id}/contributors", { path: D, body: { contributors: [{ user_id: BR, role: "DATA_COLLECTOR" }] }, status: 200 });
    await call(AS, "get", "/datasets/{dataset_id}/contributors", { path: D, status: 200 });
    await call(AS, "get", "/datasets/{dataset_id}/metadata.jsonld", { path: D, status: 200 });
    await call(A, "patch", "/me", { body: { national_researcher_number: "87654321" }, status: 200 });
    // bDisabled is not used later in the flow, so moving it does not disturb the other calls.
    await call(USER.admin, "post", "/users/{user_id}/transfer", { path: { user_id: USER.bDisabled }, body: { organization_id: ORG.a }, status: 200 });
    await call(A, "get", "/datasets/{dataset_id}/policy", { path: { dataset_id: DATASET.battery }, status: 200 });
    await call(A, "get", "/datasets/{dataset_id}/versions", { path: { dataset_id: DATASET.battery }, status: 200 });
    const v = await call(AS, "post", "/datasets/{dataset_id}/versions", { path: D, body: { version_label: "v1" }, status: 201 });
    const V = { version_id: v.dataset_version_id as string };
    await call(AS, "get", "/dataset-versions/{version_id}", { path: V, status: 200 });
    const s = await call(AS, "post", "/dataset-versions/{version_id}/upload-session", {
      path: V,
      body: { files: [{ path: "data.csv", size_bytes: 10, sha256: "a".repeat(64), media_type: "text/csv" }, { path: "extra.csv", size_bytes: 5, sha256: "b".repeat(64), media_type: "text/csv" }] },
      status: 201,
    });
    const S = { upload_session_id: s.upload_session_id as string };
    await call(AS, "get", "/upload-sessions/{upload_session_id}", { path: S, status: 200 });
    await call(AS, "post", "/upload-sessions/{upload_session_id}/complete", { path: S, body: {}, status: 200 });
    await call(AS, "delete", "/dataset-versions/{version_id}/files/{file_id}", { path: { ...V, file_id: s.files[1].file_id }, status: 204 });
    await call(AS, "post", "/dataset-versions/{version_id}/publish", { path: V, status: 200 });

    await call(A, "get", "/readiness-profiles", { status: 200 });
    await call(BS, "post", "/dataset-versions/{version_id}/readiness-validations", { path: { version_id: VERSION.battery }, body: { profile_id: "GENERIC_BASIC" }, status: 200 });
    // A markdown-only version auto-runs GENERIC_BASIC only (M05 §5), so the manual TABULAR run is queued (202).
    const v2 = await call(AS, "post", "/datasets/{dataset_id}/versions", { path: D, body: { version_label: "v2" }, status: 201 });
    const V2 = { version_id: v2.dataset_version_id as string };
    const s2 = await call(AS, "post", "/dataset-versions/{version_id}/upload-session", {
      path: V2,
      body: { files: [{ path: "notes.md", size_bytes: 20, sha256: "c".repeat(64), media_type: "text/markdown" }] },
      status: 201,
    });
    await call(AS, "post", "/upload-sessions/{upload_session_id}/complete", { path: { upload_session_id: s2.upload_session_id }, body: {}, status: 200 });
    await call(AS, "post", "/dataset-versions/{version_id}/publish", { path: V2, status: 200 });
    await call(AS, "post", "/dataset-versions/{version_id}/readiness-validations", { path: V2, body: { profile_id: "TABULAR_ML_BASIC" }, status: 202 });
    await call(A, "get", "/dataset-versions/{version_id}/readiness", { path: V, status: 200 });

    await call(A, "get", "/access-requests", { query: "role=requester", status: 200 });
    const r = await call(A, "post", "/access-requests", {
      body: { dataset_id: DATASET.battery, project_id: P.project_id, purpose: "ACADEMIC_RESEARCH", purpose_detail: "계약 검증을 위한 충분히 긴 목적 상세 설명입니다.", operations: ["READ"], requested_days: 30 },
      status: 201,
    });
    const R = { access_request_id: r.access_request_id as string };
    await call(A, "get", "/access-requests/{access_request_id}", { path: R, status: 200 });
    await call(BS, "post", "/access-requests/{access_request_id}/start-review", { path: R, status: 200 });
    const approved = await call(BS, "post", "/access-requests/{access_request_id}/approve", { path: R, body: { grant_days: 7 }, status: 200 });
    // The real seed has no second project or pending request: 최유진 creates them through the API.
    const bp = await call(BR, "post", "/projects", { body: { name: "B Study", description: "B 기관 연구" }, status: 201 });
    const sensors = await call(BR, "post", "/access-requests", {
      body: { dataset_id: DATASET.sensors, project_id: bp.project_id, purpose: "ACADEMIC_RESEARCH", purpose_detail: "센서 스트림 분석을 위한 충분히 긴 목적 상세 설명입니다.", operations: ["READ"], requested_days: 30 },
      status: 201,
    });
    await call(AS, "post", "/access-requests/{access_request_id}/reject", { path: { access_request_id: sensors.access_request_id }, body: { reason: "목적 불충분" }, status: 200 });
    const r3 = await call(BR, "post", "/access-requests", {
      body: { dataset_id: DATASET.battery, project_id: bp.project_id, purpose: "AI_TRAINING", purpose_detail: "벤치마크 모델 학습에 사용할 사이클 데이터를 요청합니다.", operations: ["READ"], requested_days: 60 },
      status: 201,
    });
    const R3 = { access_request_id: r3.access_request_id as string };
    await call(BS, "post", "/access-requests/{access_request_id}/request-changes", { path: R3, body: { comment: "기간을 줄여 주세요" }, status: 200 });
    await call(BR, "post", "/access-requests/{access_request_id}/resubmit", { path: R3, body: { requested_days: 30 }, status: 200 });
    await call(BR, "post", "/access-requests/{access_request_id}/withdraw", { path: R3, status: 200 });

    await call(A, "get", "/access-grants", { query: "role=subject", status: 200 });
    await call(A, "post", "/dataset-versions/{version_id}/download-session", { path: { version_id: VERSION.battery }, body: { project_id: P.project_id }, status: 201 });
    await call(BS, "post", "/access-grants/{access_grant_id}/revoke", { path: { access_grant_id: approved.access_grant.access_grant_id }, body: { reason: "종료" }, status: 200 });

    const file = { file_id: (await call(BS, "get", "/dataset-versions/{version_id}", { path: { version_id: VERSION.battery }, status: 200 })).files.find((f: { path: string }) => f.path === "data/measurements.csv").file_id as string };
    await call(A, "get", "/dataset-files/{file_id}/profile", { path: file, status: 200 });
    await call(BR, "get", "/dataset-files/{file_id}/preview", { path: file, status: 200 });
    await call(A, "get", "/dataset-files/{file_id}/preview", { path: file, status: 403 });

    await call(A, "get", "/audit-events", { status: 200 });
    await call(A, "get", "/notifications", { status: 200 });
    await call(A, "post", "/notifications/{notification_id}/read", { path: { notification_id: sid("7001") }, status: 200 });
    await call(A, "post", "/notifications/read-all", { status: 204 });
    await call(A, "post", "/projects/{project_id}/archive", { path: P, status: 200 });

    const METHODS = ["get", "post", "put", "patch", "delete"];
    const all = Object.values(doc.paths).flatMap((item) => Object.entries(item).filter(([m]) => METHODS.includes(m)).map(([, op]) => op.operationId));
    expect(all).toHaveLength(102);
    expect([...PENDING_MOCK_OPERATIONS].filter((id) => !all.includes(id) || exercised.has(id))).toEqual([]);
    expect(all.filter((id) => !exercised.has(id) && !PENDING_MOCK_OPERATIONS.has(id))).toEqual([]);
  });
});
