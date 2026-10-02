import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { checkResponse } from "../../tests/contract";
import { createHash } from "node:crypto";
import { DATASET, INPUT, NOTE, ORG, OUTPUT, PROJECT, sid, USER, VERSION } from "./fixtures";

type Doc = { paths: Record<string, Record<string, { operationId: string }>> };
const doc = YAML.parse(readFileSync(path.resolve(process.cwd(), "../../NAIS_PRD/contracts/openapi.yaml"), "utf8")) as Doc;

const exercised = new Set<string>();

// Operations whose mock handlers do not exist yet; an operation listed here that is exercised fails the test.
const PENDING_MOCK_OPERATIONS: ReadonlySet<string> = new Set<string>([]);

async function call(user: string | null, method: string, pathKey: string, opts: { path?: Record<string, string>; query?: string; body?: unknown; headers?: Record<string, string>; status: number }) {
  const url = pathKey.replace(/\{(\w+)\}/g, (_, k: string) => opts.path![k]!) + (opts.query ? `?${opts.query}` : "");
  const res = await fetch(`http://localhost:3000/mock-api/v1${url}`, {
    method: method.toUpperCase(),
    headers: { ...(user ? { "x-mock-user": user } : {}), "content-type": "application/json", ...opts.headers },
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

    // ---- contract 1.6.0: hub, workspace, research notes (seed project 차세대 이차전지 소재 공동연구)
    const SP = { project_id: PROJECT.seed };
    await call(A, "get", "/hub/overview", { status: 200 });
    await call(A, "get", "/datasets/{dataset_id}/projects", { path: { dataset_id: DATASET.battery }, status: 200 });
    await call(A, "get", "/datasets/{dataset_id}/activity", { path: { dataset_id: DATASET.battery }, status: 200 });

    await call(A, "get", "/projects/{project_id}/inputs", { path: SP, status: 200 });
    const input = await call(A, "post", "/projects/{project_id}/inputs", { path: SP, body: { dataset_id: DATASET.sensors, note: "공조 센서 비교" }, status: 201 });
    const I = { ...SP, input_id: input.input_id as string };
    await call(A, "patch", "/projects/{project_id}/inputs/{input_id}", { path: I, body: { note: null }, status: 200 });

    await call(A, "get", "/projects/{project_id}/recipes", { path: SP, status: 200 });
    const recipeBody = { name: "사이클 요약", input_ids: [INPUT.battery], steps: [{ type: "select_columns", columns: ["cycle", "capacity_ah"] }, { type: "limit", n: 10 }] };
    const recipe = await call(A, "post", "/projects/{project_id}/recipes", { path: SP, body: recipeBody, status: 201 });
    const RC = { ...SP, recipe_id: recipe.recipe_id as string };
    await call(A, "get", "/projects/{project_id}/recipes/{recipe_id}", { path: RC, status: 200 });
    await call(A, "put", "/projects/{project_id}/recipes/{recipe_id}", { path: RC, headers: { "if-match": '"1"' }, body: { ...recipeBody, name: "사이클 요약 v2" }, status: 200 });
    await call(A, "post", "/projects/{project_id}/recipes/{recipe_id}/preview", { path: RC, body: {}, status: 200 });
    const run = await call(A, "post", "/projects/{project_id}/recipes/{recipe_id}/runs", { path: RC, status: 202 });
    await call(A, "get", "/projects/{project_id}/runs", { path: SP, query: `recipe_id=${RC.recipe_id}`, status: 200 });
    await call(A, "get", "/projects/{project_id}/runs/{run_id}", { path: { ...SP, run_id: run.run_id }, status: 200 });
    await call(A, "delete", "/projects/{project_id}/recipes/{recipe_id}", { path: RC, status: 204 });

    await call(A, "get", "/projects/{project_id}/outputs", { path: SP, query: "kind=DERIVED_DATASET", status: 200 });
    const content = "cycle,capacity_ah\n1,3.05\n";
    const upload = await call(A, "post", "/projects/{project_id}/outputs", {
      path: SP,
      body: { title: "용량 요약표", access_level: "SENSITIVE", files: [{ name: "summary.csv", size_bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex"), media_type: "text/csv" }] },
      status: 201,
    });
    expect((await fetch(upload.files[0].upload.url, { method: "PUT", body: content })).status).toBe(200);
    await call(A, "post", "/projects/{project_id}/outputs/{output_id}/complete", { path: { ...SP, output_id: upload.output_id }, status: 200 });
    const O = { ...SP, output_id: OUTPUT.capacity };
    await call(A, "get", "/projects/{project_id}/outputs/{output_id}", { path: O, status: 200 });
    await call(A, "post", "/projects/{project_id}/outputs/{output_id}/download", { path: O, status: 201 });
    const pub = await call(A, "post", "/projects/{project_id}/outputs/{output_id}/publish-requests", { path: O, body: { title: "용량 유지율 추이 파생 데이터" }, status: 201 });
    await call(BS, "get", "/publish-requests", { query: "role=reviewer&status=PENDING", status: 200 });
    await call(BS, "post", "/publish-requests/{request_id}/decision", { path: { request_id: pub.request_id }, body: { decision: "APPROVE" }, status: 200 });

    const thread = await call(A, "post", "/threads", { body: { scope: "PROJECT", target_id: PROJECT.seed, title: "주간 점검", body: "이번 주 실행 결과를 공유합니다." }, status: 201 });
    await call(A, "get", "/threads", { query: `project_id=${PROJECT.seed}`, status: 200 });
    await call(A, "patch", "/threads/{thread_id}", { path: { thread_id: thread.thread_id }, body: { resolved: true }, status: 200 });
    await call(BR, "post", "/threads/{thread_id}/comments", { path: { thread_id: thread.thread_id }, body: { body: "확인했습니다." }, status: 201 });
    await call(A, "get", "/threads/{thread_id}/comments", { path: { thread_id: thread.thread_id }, status: 200 });
    await call(A, "delete", "/projects/{project_id}/inputs/{input_id}", { path: I, status: 204 });

    await call(A, "get", "/notes", { query: "role=recorder", status: 200 });
    const zipRes = await fetch(`http://localhost:3000/mock-api/v1/notes/export?project_id=${PROJECT.seed}`, { headers: { "x-mock-user": A } });
    exercised.add("exportNotes");
    expect(zipRes.status).toBe(200);
    expect(zipRes.headers.get("content-type")).toBe("application/zip");
    await call(A, "get", "/notes/search", { query: "q=temp_c", status: 200 });
    await call(A, "get", "/projects/{project_id}/note-settings", { path: SP, status: 200 });
    await call(A, "patch", "/projects/{project_id}/note-settings", { path: SP, body: { witness_required: false }, status: 200 });
    await call(A, "get", "/notes/{note_id}", { path: { note_id: NOTE.signed }, status: 200 });
    const today = await call(BR, "post", "/projects/{project_id}/notes/today", { path: SP, status: 201 });
    const N = { note_id: today.note_id as string };
    await call(BR, "put", "/notes/{note_id}/blocks", { path: N, headers: { "if-match": "1" }, body: { blocks: [{ section: "OBJECTIVE", text: "temp_c 주기적 상승 원인 확인" }] }, status: 200 });
    await call(BR, "post", "/notes/{note_id}/draft", { path: N, status: 422 });
    await call(BR, "post", "/notes/{note_id}/submit", { path: N, status: 200 });
    await call(A, "post", "/notes/{note_id}/reject", { path: N, body: { reason: "근거 보완" }, status: 403 });
    await call(BR, "post", "/notes/{note_id}/sign", { path: N, status: 200 });
    await call(BR, "get", "/notes/{note_id}/verify", { path: N, status: 200 });
    const revised = await call(BR, "post", "/notes/{note_id}/revise", { path: N, status: 201 });
    await call(BR, "delete", "/notes/{note_id}", { path: { note_id: revised.note_id }, status: 204 });

    const METHODS = ["get", "post", "put", "patch", "delete"];
    const all = Object.values(doc.paths).flatMap((item) => Object.entries(item).filter(([m]) => METHODS.includes(m)).map(([, op]) => op.operationId));
    expect(all).toHaveLength(102);
    expect([...PENDING_MOCK_OPERATIONS].filter((id) => !all.includes(id) || exercised.has(id))).toEqual([]);
    expect(all.filter((id) => !exercised.has(id) && !PENDING_MOCK_OPERATIONS.has(id))).toEqual([]);
  });
});
