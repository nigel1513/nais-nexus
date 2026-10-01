import { describe, expect, it } from "vitest";
import { setMockUser } from "../../../tests/render";
import { api, unwrap } from "@/shared/api/client";
import type { AccessGrant, AuditEvent, DatasetVersion, Page, ReadinessValidation, SearchPage } from "@/shared/api/types";
import { getDb } from "../db";
import { DATASET, GRANT, ORG, PROJECT, USER, VERSION } from "../fixtures";

const as = (user: string) => setMockUser(user);
const MiB = 1024 * 1024;

async function search(user: string, query: Record<string, unknown> = {}) {
  as(user);
  return (await unwrap(api.GET("/datasets", { params: { query } }))) as SearchPage;
}

describe("catalog mocks", () => {
  it("applies the seed-check visibility rules", async () => {
    const a = await search(USER.aResearcher);
    const ids = a.items.map((h) => h.dataset_id);
    expect(ids).toEqual(expect.arrayContaining([DATASET.battery, DATASET.openMaterials, DATASET.sensors, DATASET.electrolyte]));
    expect(ids).not.toContain(DATASET.qcLogs);
    const b = await search(USER.bResearcher);
    expect(b.items.map((h) => h.dataset_id)).toContain(DATASET.qcLogs);
  });

  it("filters by q and access level and returns facets", async () => {
    const res = await search(USER.aResearcher, { q: "battery" });
    expect(res.items.map((h) => h.title)).toEqual(["Battery Cycling Measurements"]);
    const controlled = await search(USER.aResearcher, { access_level: ["CONTROLLED"] });
    expect(controlled.items.every((h) => h.access_level === "CONTROLLED")).toBe(true);
    // Real searchDatasets aggregates under the active filters (no post_filter).
    expect(controlled.facets.access_level).toEqual([{ value: "CONTROLLED", count: 2 }]);
    expect(controlled.total).toBe(2);
    expect(res.total).toBe(1);
    const all = await search(USER.aResearcher);
    expect(all.facets.owner_organization_id).toEqual(expect.arrayContaining([{ value: getDb().organizations[2]!.organization_id, count: 2, label: "Institute B" }]));
  });

  it("only DATA_STEWARD of the owner org can register datasets; SENSITIVE is capped at 30 days", async () => {
    as(USER.aResearcher);
    const base = { owner_organization_id: getDb().organizations[1]!.organization_id, title: "New set", description: "d", license: "CC-BY-4.0", allowed_purposes: ["ACADEMIC_RESEARCH" as const], max_grant_days: 90, principal_investigator_id: USER.aSteward, data_steward_contact_id: USER.aSteward, contact_email_public: false };
    await expect(unwrap(api.POST("/datasets", { body: { ...base, access_level: "CONTROLLED" } }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    as(USER.aSteward);
    await expect(unwrap(api.POST("/datasets", { body: { ...base, access_level: "SENSITIVE", max_grant_days: 60 } }))).rejects.toMatchObject({ code: "INVALID_POLICY" });
    const created = await unwrap(api.POST("/datasets", { body: { ...base, access_level: "SENSITIVE", max_grant_days: 30 } }));
    expect(created.policy).toMatchObject({ access_level: "SENSITIVE", max_grant_days: 30, approval_required: true });
  });

  it("PATCH rejects null on non-nullable fields (StrictIn) with VALIDATION_FAILED", async () => {
    as(USER.bSteward);
    await expect(unwrap(api.PATCH("/datasets/{dataset_id}", { params: { path: { dataset_id: DATASET.battery } }, body: { domain: null } as never }))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { fields: [{ field: "domain", reason: "NULL_NOT_ALLOWED" }] },
    });
    expect(getDb().datasets.find((d) => d.dataset_id === DATASET.battery)?.domain).toBe("energy");
  });

  it("hides DRAFT versions from non-stewards", async () => {
    as(USER.aResearcher);
    const plain = await unwrap(api.GET("/datasets/{dataset_id}/versions", { params: { path: { dataset_id: DATASET.electrolyte } } }));
    expect(plain.items).toHaveLength(0);
    as(USER.aSteward);
    const steward = await unwrap(api.GET("/datasets/{dataset_id}/versions", { params: { path: { dataset_id: DATASET.electrolyte } } }));
    expect(steward.items.map((v) => v.status)).toEqual(["DRAFT"]);
  });

  it("runs upload → complete → publish → readiness polling", async () => {
    as(USER.aSteward);
    const path = { version_id: VERSION.electrolyte };
    await expect(unwrap(api.POST("/dataset-versions/{version_id}/publish", { params: { path } }))).rejects.toMatchObject({ code: "DATASET_VERSION_INCOMPLETE" });
    const session = await unwrap(
      api.POST("/dataset-versions/{version_id}/upload-session", {
        params: { path },
        body: {
          files: [
            { path: "screening/data.csv", size_bytes: 1000, sha256: "a".repeat(64), media_type: "text/csv" },
            { path: "screening/big.parquet", size_bytes: 100 * MiB, sha256: "b".repeat(64), media_type: "application/vnd.apache.parquet" },
          ],
        },
      }),
    );
    expect(session.files.map((f) => f.path)).toEqual(["screening/big.parquet", "screening/data.csv"]); // ordered by path like the API
    const small = session.files.find((f) => f.path.endsWith("data.csv"))!;
    const big = session.files.find((f) => f.path.endsWith("big.parquet"))!;
    expect(small!.upload).toMatchObject({ method: "PUT" });
    expect((small!.upload as { url: string }).url).toMatch(/^http:\/\/localhost:3000\/mock-storage\/nais-inst-a\/uploads\//);
    expect(big!.upload).toMatchObject({ method: "MULTIPART", part_size_bytes: 64 * MiB });
    expect((big!.upload as { parts: unknown[] }).parts).toHaveLength(2);
    const done = await unwrap(
      api.POST("/upload-sessions/{upload_session_id}/complete", {
        params: { path: { upload_session_id: session.upload_session_id } },
        body: { parts: [{ file_id: big!.file_id, etags: [{ part_number: 1, etag: "e1" }, { part_number: 2, etag: "e2" }] }] },
      }),
    );
    expect(done.files.map((f) => f.status)).toEqual(["VERIFIED", "VERIFIED"]);
    const published = await unwrap(api.POST("/dataset-versions/{version_id}/publish", { params: { path } }));
    expect(published).toMatchObject({ status: "PUBLISHED", file_count: 2 });
    const poll = async () => (await unwrap(api.GET("/dataset-versions/{version_id}/readiness", { params: { path } }))).items as ReadinessValidation[];
    expect((await poll()).map((v) => v.run_status)).toEqual(expect.arrayContaining(["RUNNING"]));
    const final = await poll();
    expect(final.every((v) => v.run_status === "COMPLETED" && v.overall_status)).toBe(true);
    await expect(unwrap(api.POST("/dataset-versions/{version_id}/upload-session", { params: { path }, body: { files: [{ path: "x.csv", size_bytes: 1, sha256: "c".repeat(64), media_type: "text/csv" }] } }))).rejects.toMatchObject({
      code: "DATASET_VERSION_IMMUTABLE",
    });
  });

  it("rejects unsafe upload paths and oversized files", async () => {
    as(USER.aSteward);
    const path = { version_id: VERSION.electrolyte };
    const file = (p: string, size = 10) => ({ files: [{ path: p, size_bytes: size, sha256: "d".repeat(64), media_type: "text/csv" }] });
    await expect(unwrap(api.POST("/dataset-versions/{version_id}/upload-session", { params: { path }, body: file("../etc/passwd") }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(unwrap(api.POST("/dataset-versions/{version_id}/upload-session", { params: { path }, body: file("데이터.csv") }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(unwrap(api.POST("/dataset-versions/{version_id}/upload-session", { params: { path }, body: file("huge.csv", 51 * 1024 ** 3) }))).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await expect(unwrap(api.POST("/dataset-versions/{version_id}/upload-session", { params: { path }, body: file("tool.exe") }))).rejects.toMatchObject({ code: "FILE_TYPE_NOT_ALLOWED" });
    await expect(unwrap(api.POST("/dataset-versions/{version_id}/upload-session", { params: { path }, body: file("data.json") }))).rejects.toMatchObject({ code: "FILE_TYPE_NOT_ALLOWED" }); // media type must match the extension
    const dup = { files: [...file("a.csv").files, ...file("a.csv").files] };
    await expect(unwrap(api.POST("/dataset-versions/{version_id}/upload-session", { params: { path }, body: dup }))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { fields: [{ field: "files.1.path", reason: "DUPLICATE_PATH" }] },
    });
    await expect(unwrap(api.POST("/dataset-versions/{version_id}/upload-session", { params: { path }, body: file("../etc/passwd") }))).rejects.toMatchObject({
      details: { fields: [{ field: "files.0.path", reason: "DOT_SEGMENT" }] },
    });
  });
});

describe("governance mocks", () => {
  async function newProject() {
    as(USER.aResearcher);
    return unwrap(api.POST("/projects", { body: { name: "E2E Joint Study", description: "공동 연구" } }));
  }
  /** The real seed has only one project/request, so cross-org requests are created through the API. */
  async function sensorsRequest(): Promise<string> {
    as(USER.bResearcher);
    const project = await unwrap(api.POST("/projects", { body: { name: "B Sensor Study", description: "센서 연구" } }));
    const req = await unwrap(
      api.POST("/access-requests", {
        body: { dataset_id: DATASET.sensors, project_id: project.project_id, purpose: "ACADEMIC_RESEARCH", purpose_detail: detail, operations: ["READ"], requested_days: 30 },
      }),
    );
    return req.access_request_id;
  }
  const detail = "배터리 열화 예측 모델의 학술 연구를 위해 사이클 데이터를 분석합니다.";

  it("runs request → review → approve → download → revoke → denied", async () => {
    const project = await newProject();
    const req = await unwrap(
      api.POST("/access-requests", {
        body: { dataset_id: DATASET.battery, project_id: project.project_id, purpose: "ACADEMIC_RESEARCH", purpose_detail: detail, operations: ["READ"], requested_days: 30 },
      }),
    );
    expect(req.status).toBe("SUBMITTED");
    expect(getDb().notifications.some((n) => n.user_id === USER.bSteward && n.type === "ACCESS_SUBMITTED")).toBe(true);

    as(USER.bSteward);
    const queue = await unwrap(api.GET("/access-requests", { params: { query: { role: "reviewer", status: ["SUBMITTED", "UNDER_REVIEW"] } } }));
    expect((queue.items as { access_request_id: string }[]).map((r) => r.access_request_id)).toContain(req.access_request_id);
    const reviewing = await unwrap(api.POST("/access-requests/{access_request_id}/start-review", { params: { path: { access_request_id: req.access_request_id } } }));
    expect(reviewing.status).toBe("UNDER_REVIEW");
    const decision = await unwrap(
      api.POST("/access-requests/{access_request_id}/approve", { params: { path: { access_request_id: req.access_request_id } }, body: { grant_days: 7 } }),
    );
    expect(decision.access_request.status).toBe("APPROVED");
    const grant = decision.access_grant!;
    expect(Date.parse(grant.expires_at) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);

    as(USER.aResearcher);
    const dl = await unwrap(api.POST("/dataset-versions/{version_id}/download-session", { params: { path: { version_id: VERSION.battery } }, body: { project_id: project.project_id } }));
    expect(dl.basis).toBe("GRANT");
    expect(dl.files[0]!.url).toMatch(/\/mock-storage\/nais-inst-b\/datasets\//);

    as(USER.bSteward);
    await unwrap(api.POST("/access-grants/{access_grant_id}/revoke", { params: { path: { access_grant_id: grant.access_grant_id } }, body: { reason: "과제 종료" } }));
    await expect(
      unwrap(api.POST("/access-grants/{access_grant_id}/revoke", { params: { path: { access_grant_id: grant.access_grant_id } }, body: { reason: "again" } })),
    ).rejects.toMatchObject({ code: "ACCESS_GRANT_NOT_ACTIVE" });

    as(USER.aResearcher);
    await expect(
      unwrap(api.POST("/dataset-versions/{version_id}/download-session", { params: { path: { version_id: VERSION.battery } }, body: { project_id: project.project_id } })),
    ).rejects.toMatchObject({ status: 403, code: "ACCESS_GRANT_REVOKED" });
    const audit = (await unwrap(api.GET("/audit-events", { params: { query: { action: ["DOWNLOAD_DENIED", "FILE_DOWNLOADED"] } } }))) as Page<AuditEvent>;
    expect(audit.items.map((e) => e.action)).toEqual(expect.arrayContaining(["DOWNLOAD_DENIED", "FILE_DOWNLOADED"]));
  });

  it("reports expired grants as EXPIRED and denies download with ACCESS_GRANT_EXPIRED", async () => {
    getDb().grants.find((g) => g.access_grant_id === GRANT.seed)!.expires_at = new Date(Date.now() - 1000).toISOString();
    as(USER.aResearcher);
    const grants = (await unwrap(api.GET("/access-grants", { params: { query: { role: "subject" } } }))) as Page<AccessGrant>;
    expect(grants.items.find((g) => g.access_grant_id === GRANT.seed)?.status).toBe("EXPIRED");
    await expect(
      unwrap(api.POST("/dataset-versions/{version_id}/download-session", { params: { path: { version_id: VERSION.battery } }, body: { project_id: PROJECT.seed } })),
    ).rejects.toMatchObject({ code: "ACCESS_GRANT_EXPIRED" });
  });

  it("enforces policy on new requests", async () => {
    const project = await newProject();
    const make = (patch: Record<string, unknown>) =>
      unwrap(api.POST("/access-requests", { body: { dataset_id: DATASET.battery, project_id: project.project_id, purpose: "ACADEMIC_RESEARCH", purpose_detail: detail, operations: ["READ"], requested_days: 30, ...patch } as never }));
    await expect(make({ purpose: "COMMERCIAL_RESEARCH" })).rejects.toMatchObject({ code: "ACCESS_PURPOSE_NOT_ALLOWED" });
    await expect(make({ requested_days: 181 })).rejects.toMatchObject({ code: "ACCESS_DURATION_EXCEEDED" });
    await expect(make({ operations: ["WRITE"] })).rejects.toMatchObject({ code: "ACCESS_OPERATION_NOT_ALLOWED" });
    await expect(make({ dataset_id: DATASET.openMaterials })).rejects.toMatchObject({ code: "ACCESS_NOT_REQUIRED" });
    as(USER.bResearcher);
    const foreign = await unwrap(api.POST("/projects", { body: { name: "B Only Project", description: "다른 기관 전용" } }));
    as(USER.aResearcher);
    await expect(make({ project_id: foreign.project_id })).rejects.toMatchObject({ code: "ACCESS_NOT_PROJECT_MEMBER" });
    await make({});
    await expect(make({})).rejects.toMatchObject({ code: "ACCESS_REQUEST_DUPLICATE" });
  });

  it("returns ACCESS_REQUEST_INVALID_STATE when a request was already handled", async () => {
    const pending = await sensorsRequest();
    as(USER.bResearcher);
    await unwrap(api.POST("/access-requests/{access_request_id}/withdraw", { params: { path: { access_request_id: pending } } }));
    as(USER.aSteward);
    await expect(
      unwrap(api.POST("/access-requests/{access_request_id}/approve", { params: { path: { access_request_id: pending } }, body: { grant_days: 7 } })),
    ).rejects.toMatchObject({ status: 409, code: "ACCESS_REQUEST_INVALID_STATE" });
  });

  it("allows PUBLIC downloads without a project", async () => {
    as(USER.aResearcher);
    const dl = await unwrap(api.POST("/dataset-versions/{version_id}/download-session", { params: { path: { version_id: VERSION.openMaterials } }, body: {} }));
    expect(dl.basis).toBe("PUBLIC");
    expect(Date.parse(dl.expires_at) - Date.now()).toBeLessThanOrEqual(300_000);
  });

  it("serves DATA_STEWARD version detail with files", async () => {
    as(USER.bSteward);
    const v = (await unwrap(api.GET("/dataset-versions/{version_id}", { params: { path: { version_id: VERSION.battery } } }))) as DatasetVersion;
    expect(v.files).toHaveLength(5);
    expect(v.readiness_overall).toBe("PASS");
  });
});

describe("catalog rules mirrored from apps/api/modules/catalog", () => {
  const vpath = { version_id: VERSION.electrolyte };
  const session = (user: string, files: { path: string; size_bytes: number }[]) => {
    as(user);
    return unwrap(
      api.POST("/dataset-versions/{version_id}/upload-session", {
        params: { path: vpath },
        body: { files: files.map((f) => ({ ...f, sha256: "e".repeat(64), media_type: f.path.endsWith(".parquet") ? "application/vnd.apache.parquet" : "text/csv" })) },
      }),
    );
  };

  it("D-012/D-040: other orgs cannot see unpublished or INTERNAL datasets; owner org and admins see WITHDRAWN", async () => {
    as(USER.bResearcher);
    await expect(unwrap(api.GET("/datasets/{dataset_id}", { params: { path: { dataset_id: DATASET.electrolyte } } }))).rejects.toMatchObject({ status: 404 });
    as(USER.aResearcher);
    await expect(unwrap(api.GET("/datasets/{dataset_id}", { params: { path: { dataset_id: DATASET.qcLogs } } }))).rejects.toMatchObject({ status: 404 });
    as(USER.bSteward);
    await unwrap(api.PATCH("/datasets/{dataset_id}", { params: { path: { dataset_id: DATASET.battery } }, body: { status: "WITHDRAWN" } }));
    as(USER.aResearcher);
    await expect(unwrap(api.GET("/datasets/{dataset_id}", { params: { path: { dataset_id: DATASET.battery } } }))).rejects.toMatchObject({ status: 404 });
    as(USER.bResearcher);
    expect((await unwrap(api.GET("/datasets/{dataset_id}", { params: { path: { dataset_id: DATASET.battery } } }))).status).toBe("WITHDRAWN");
    expect((await search(USER.bResearcher)).items.map((h) => h.dataset_id)).not.toContain(DATASET.battery);
    as(USER.bSteward);
    await expect(unwrap(api.PATCH("/datasets/{dataset_id}", { params: { path: { dataset_id: DATASET.battery } }, body: { title: "Renamed" } }))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(unwrap(api.POST("/datasets/{dataset_id}/versions", { params: { path: { dataset_id: DATASET.battery } }, body: { version_label: "v2" } }))).rejects.toMatchObject({ code: "CONFLICT" });
    const back = await unwrap(api.PATCH("/datasets/{dataset_id}", { params: { path: { dataset_id: DATASET.battery } }, body: { status: "ACTIVE" } }));
    expect(back.status).toBe("ACTIVE");
  });

  it("DRAFT versions are 404 for non-admins; ORG_ADMIN sees them but cannot write (steward-only)", async () => {
    as(USER.aResearcher);
    await expect(unwrap(api.GET("/dataset-versions/{version_id}", { params: { path: vpath } }))).rejects.toMatchObject({ status: 404 });
    await expect(unwrap(api.GET("/dataset-versions/{version_id}/readiness", { params: { path: vpath } }))).rejects.toMatchObject({ status: 404 });
    as(USER.aAdmin);
    expect((await unwrap(api.GET("/dataset-versions/{version_id}", { params: { path: vpath } }))).status).toBe("DRAFT");
    await expect(session(USER.aAdmin, [{ path: "a.csv", size_bytes: 1 }])).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(session(USER.bSteward, [{ path: "a.csv", size_bytes: 1 }])).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a second session for a path that is already uploaded or pending, and polls large uploads to VERIFIED", async () => {
    const first = await session(USER.aSteward, [{ path: "big.parquet", size_bytes: 300 * MiB }]);
    await expect(session(USER.aSteward, [{ path: "big.parquet", size_bytes: 1 }])).rejects.toMatchObject({ code: "CONFLICT" });
    const f = first.files[0]!;
    const sid = { upload_session_id: first.upload_session_id };
    await expect(unwrap(api.POST("/upload-sessions/{upload_session_id}/complete", { params: { path: sid }, body: {} }))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { fields: [{ field: "parts", reason: "MISSING_PARTS", file_id: f.file_id }] },
    });
    as(USER.aSteward);
    await expect(unwrap(api.DELETE("/dataset-versions/{version_id}/files/{file_id}", { params: { path: { ...vpath, file_id: f.file_id } } }))).rejects.toMatchObject({ code: "CONFLICT" });
    const etags = [1, 2, 3, 4, 5].map((n) => ({ part_number: n, etag: `e${n}` }));
    const done = await unwrap(api.POST("/upload-sessions/{upload_session_id}/complete", { params: { path: sid }, body: { parts: [{ file_id: f.file_id, etags }] } }));
    expect(done.files[0]).toMatchObject({ status: "UPLOADED" }); // > 256 MiB: verified asynchronously (openapi)
    expect(done.files[0]).not.toHaveProperty("upload");
    await expect(unwrap(api.POST("/dataset-versions/{version_id}/publish", { params: { path: vpath } }))).rejects.toMatchObject({ code: "DATASET_VERSION_INCOMPLETE" });
    const polled = await unwrap(api.GET("/upload-sessions/{upload_session_id}", { params: { path: sid } }));
    expect(polled.files[0]).toMatchObject({ status: "VERIFIED" });
    await unwrap(api.POST("/dataset-versions/{version_id}/publish", { params: { path: vpath } }));
  });

  it("reports corrupt uploads as FAILED and lets the steward re-upload the path", async () => {
    const s = await session(USER.aSteward, [{ path: "corrupt.csv", size_bytes: 5 }]);
    const done = await unwrap(api.POST("/upload-sessions/{upload_session_id}/complete", { params: { path: { upload_session_id: s.upload_session_id } }, body: {} }));
    expect(done.files[0]).toMatchObject({ status: "FAILED", failure_code: "CHECKSUM_MISMATCH" });
    const again = await session(USER.aSteward, [{ path: "corrupt.csv", size_bytes: 5 }]);
    expect(again.files[0]!.file_id).toBe(s.files[0]!.file_id);
    await expect(unwrap(api.POST("/upload-sessions/{upload_session_id}/complete", { params: { path: { upload_session_id: s.upload_session_id } }, body: {} }))).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("expired sessions cannot be completed and show EXPIRED without upload instructions", async () => {
    const s = await session(USER.aSteward, [{ path: "late.csv", size_bytes: 5 }]);
    getDb().uploadSessions.find((x) => x.upload_session_id === s.upload_session_id)!.expires_at = new Date(Date.now() - 1000).toISOString();
    const got = await unwrap(api.GET("/upload-sessions/{upload_session_id}", { params: { path: { upload_session_id: s.upload_session_id } } }));
    expect(got.status).toBe("EXPIRED");
    expect(got.files[0]).not.toHaveProperty("upload");
    await expect(unwrap(api.POST("/upload-sessions/{upload_session_id}/complete", { params: { path: { upload_session_id: s.upload_session_id } }, body: {} }))).rejects.toMatchObject({ code: "UPLOAD_SESSION_EXPIRED" });
  });

  it("publish freezes a real manifest hash and enqueues both auto validations for tabular files", async () => {
    const s = await session(USER.aSteward, [{ path: "notes.csv", size_bytes: 5 }]);
    await unwrap(api.POST("/upload-sessions/{upload_session_id}/complete", { params: { path: { upload_session_id: s.upload_session_id } }, body: {} }));
    const v = await unwrap(api.POST("/dataset-versions/{version_id}/publish", { params: { path: vpath } }));
    expect(v.manifest_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(getDb().validations.filter((x) => x.dataset_version_id === VERSION.electrolyte).map((x) => x.profile_id).sort()).toEqual(["GENERIC_BASIC", "TABULAR_ML_BASIC"]);
    await expect(unwrap(api.POST("/dataset-versions/{version_id}/publish", { params: { path: vpath } }))).rejects.toMatchObject({ code: "DATASET_VERSION_IMMUTABLE" });
  });
});

describe("readiness rules (M05 §6)", () => {
  const start = (version: string, profile: string) =>
    api.POST("/dataset-versions/{version_id}/readiness-validations", { params: { path: { version_id: version } }, body: { profile_id: profile } });

  it("returns 200 with the existing result for an identical completed run, 403 for non-stewards, 422 for unknown profiles, 409 for drafts", async () => {
    as(USER.bResearcher);
    await expect(unwrap(start(VERSION.battery, "GENERIC_BASIC"))).rejects.toMatchObject({ status: 403 });
    as(USER.bSteward);
    const res = await start(VERSION.battery, "GENERIC_BASIC");
    expect(res.response.status).toBe(200);
    await expect(unwrap(start(VERSION.battery, "FOO"))).rejects.toMatchObject({ code: "READINESS_PROFILE_UNKNOWN" });
    as(USER.aSteward);
    await expect(unwrap(start(VERSION.electrolyte, "GENERIC_BASIC"))).rejects.toMatchObject({ code: "DATASET_VERSION_NOT_PUBLISHED" });
    await expect(unwrap(api.GET("/dataset-versions/{version_id}/readiness", { params: { path: { version_id: VERSION.battery }, query: { profile_id: "NOPE" } } }))).rejects.toMatchObject({ code: "READINESS_NOT_AVAILABLE" });
  });
});

describe("governance rules (M04 §6)", () => {
  const detail = "배터리 열화 예측 모델의 학술 연구를 위해 사이클 데이터를 분석합니다.";

  it("role=reviewer is FORBIDDEN for non-stewards", async () => {
    as(USER.bResearcher);
    await expect(unwrap(api.GET("/access-requests", { params: { query: { role: "reviewer" } } }))).rejects.toMatchObject({ status: 403 });
    await expect(unwrap(api.GET("/access-grants", { params: { query: { role: "owner" } } }))).rejects.toMatchObject({ status: 403 });
  });

  it("download-session follows M04 §6.12: project required (422), membership, and INTERNAL stays hidden from other orgs", async () => {
    as(USER.aResearcher);
    await expect(unwrap(api.POST("/dataset-versions/{version_id}/download-session", { params: { path: { version_id: VERSION.battery } }, body: {} }))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { fields: [{ field: "project_id" }] },
    });
    await expect(unwrap(api.POST("/dataset-versions/{version_id}/download-session", { params: { path: { version_id: VERSION.qcLogs } }, body: {} }))).rejects.toMatchObject({ status: 404 });
    await expect(
      unwrap(api.POST("/dataset-versions/{version_id}/download-session", { params: { path: { version_id: VERSION.battery } }, body: { project_id: PROJECT.seed, file_ids: [crypto.randomUUID()] } })),
    ).rejects.toMatchObject({ status: 404 });
    as(USER.bSteward);
    const own = await unwrap(api.POST("/dataset-versions/{version_id}/download-session", { params: { path: { version_id: VERSION.qcLogs } }, body: {} }));
    expect(own.basis).toBe("OWNER_ORGANIZATION");
    as(USER.bResearcher); // owner org, plain member, CONTROLLED → still needs a grant
    await expect(unwrap(api.POST("/dataset-versions/{version_id}/download-session", { params: { path: { version_id: VERSION.battery } }, body: { project_id: PROJECT.seed } }))).rejects.toMatchObject({ code: "ACCESS_GRANT_REQUIRED" });
  });

  it("owner-org stewards get ACCESS_NOT_REQUIRED; resubmit re-applies the policy rules", async () => {
    as(USER.aResearcher);
    const project = await unwrap(api.POST("/projects", { body: { name: "Resubmit Study", description: "재제출" } }));
    const base = { dataset_id: DATASET.battery, project_id: project.project_id, purpose: "ACADEMIC_RESEARCH" as const, purpose_detail: detail, operations: ["READ" as const], requested_days: 30 };
    const req = await unwrap(api.POST("/access-requests", { body: base }));
    as(USER.bSteward);
    await unwrap(api.POST("/access-requests/{access_request_id}/request-changes", { params: { path: { access_request_id: req.access_request_id } }, body: { comment: "기간 조정" } }));
    as(USER.aResearcher);
    await expect(
      unwrap(api.POST("/access-requests/{access_request_id}/resubmit", { params: { path: { access_request_id: req.access_request_id } }, body: { requested_days: 365 } })),
    ).rejects.toMatchObject({ code: "ACCESS_DURATION_EXCEEDED" });
    const again = await unwrap(api.POST("/access-requests/{access_request_id}/resubmit", { params: { path: { access_request_id: req.access_request_id } }, body: { requested_days: 14 } }));
    expect(again.status).toBe("SUBMITTED");
    expect(again.history?.map((h) => h.status)).toEqual(["SUBMITTED", "CHANGE_REQUESTED", "SUBMITTED"]);
    as(USER.bSteward);
    const own = await unwrap(api.POST("/projects", { body: { name: "Steward Project", description: "자기 기관 데이터" } }));
    await expect(unwrap(api.POST("/access-requests", { body: { ...base, project_id: own.project_id } }))).rejects.toMatchObject({ code: "ACCESS_NOT_REQUIRED" });
  });

  describe("edge rules (Task 6 review)", () => {
    const dlBody = { project_id: PROJECT.seed };
    const denials = () => getDb().audit.filter((e) => e.action === "DOWNLOAD_DENIED");

    it("download-session on a WITHDRAWN dataset is 404 and audited", async () => {
      getDb().datasets.find((d) => d.dataset_id === DATASET.battery)!.status = "WITHDRAWN";
      as(USER.aResearcher);
      await expect(unwrap(api.POST("/dataset-versions/{version_id}/download-session", { params: { path: { version_id: VERSION.battery } }, body: dlBody }))).rejects.toMatchObject({ status: 404 });
      expect(denials().some((e) => e.resource.id === VERSION.battery)).toBe(true);
    });

    it("download-session refusals at step 1 (invisible/unknown version) are audited too", async () => {
      as(USER.aResearcher);
      await expect(unwrap(api.POST("/dataset-versions/{version_id}/download-session", { params: { path: { version_id: VERSION.qcLogs } }, body: {} }))).rejects.toMatchObject({ status: 404 });
      expect(denials().some((e) => e.resource.id === VERSION.qcLogs && e.actor.user_id === USER.aResearcher)).toBe(true);
    });

    it("revoke by a grant's subject (visible, no steward role) is 403, not 404", async () => {
      as(USER.aResearcher);
      await expect(unwrap(api.POST("/access-grants/{access_grant_id}/revoke", { params: { path: { access_grant_id: GRANT.seed } }, body: { reason: "x" } }))).rejects.toMatchObject({ status: 403 });
      as(USER.aSteward); // unrelated org: invisible
      await expect(unwrap(api.POST("/access-grants/{access_grant_id}/revoke", { params: { path: { access_grant_id: GRANT.seed } }, body: { reason: "x" } }))).rejects.toMatchObject({ status: 404 });
    });

    it("start-review is idempotent only for the reviewer who started it", async () => {
      as(USER.aResearcher);
      const project = await unwrap(api.POST("/projects", { body: { name: "Review Study", description: "검토" } }));
      const req = await unwrap(
        api.POST("/access-requests", {
          body: { dataset_id: DATASET.battery, project_id: project.project_id, purpose: "ACADEMIC_RESEARCH", purpose_detail: detail, operations: ["READ"], requested_days: 30 },
        }),
      );
      const path = { access_request_id: req.access_request_id };
      as(USER.bSteward);
      await unwrap(api.POST("/access-requests/{access_request_id}/start-review", { params: { path } }));
      const again = await unwrap(api.POST("/access-requests/{access_request_id}/start-review", { params: { path } }));
      expect(again.status).toBe("UNDER_REVIEW");
      const second = { ...getDb().users.find((u) => u.user_id === USER.bSteward)!, user_id: crypto.randomUUID(), email: "second.steward@example.org" };
      getDb().users.push(second);
      as(second.user_id);
      await expect(unwrap(api.POST("/access-requests/{access_request_id}/start-review", { params: { path } }))).rejects.toMatchObject({ code: "ACCESS_REQUEST_INVALID_STATE" });
    });

    it("upload-session rejects a missing media_type with 422", async () => {
      as(USER.aSteward);
      const body = { files: [{ path: "a.csv", size_bytes: 10, sha256: "d".repeat(64) }] } as never;
      await expect(unwrap(api.POST("/dataset-versions/{version_id}/upload-session", { params: { path: { version_id: VERSION.electrolyte } }, body }))).rejects.toMatchObject({
        status: 422,
        details: { fields: [{ field: "files.0.media_type" }] },
      });
    });

    it("PATCH dataset accepts only DatasetUpdate keys", async () => {
      as(USER.bSteward);
      const body = { title: "Renamed", owner_organization_id: crypto.randomUUID() } as never;
      await expect(unwrap(api.PATCH("/datasets/{dataset_id}", { params: { path: { dataset_id: DATASET.battery } }, body }))).rejects.toMatchObject({
        status: 422,
        details: { fields: [{ field: "owner_organization_id", reason: "UNKNOWN_FIELD" }] },
      });
      expect(getDb().datasets.find((d) => d.dataset_id === DATASET.battery)!.title).not.toBe("Renamed");
    });
  });
});

const BASE = "http://localhost:3000/mock-api/v1";
async function send(user: string, method: string, path: string, body?: unknown) {
  return fetch(`${BASE}${path}`, { method, headers: { "x-mock-user": user, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function getJson(user: string, path: string) {
  const res = await send(user, "GET", path);
  expect(res.status).toBe(200);
  return res.json();
}
const datasetCreate = (org: string) => ({
  owner_organization_id: org,
  title: "Research set",
  description: "d",
  license: "CC-BY-4.0",
  access_level: "CONTROLLED",
  allowed_purposes: ["ACADEMIC_RESEARCH"],
  max_grant_days: 90,
  principal_investigator_id: org === ORG.b ? USER.bResearcher : USER.aResearcher,
  data_steward_contact_id: org === ORG.b ? USER.bSteward : USER.aSteward,
  contact_email_public: false,
});

describe("Stage 1 research metadata (mock mirrors backend Tasks 5–9)", () => {
  it("returns people with at-the-time and current affiliation, email only when public", async () => {
    const battery = await getJson(USER.aResearcher, `/datasets/${DATASET.battery}`);
    expect(battery.subtitle).toBe("리튬이온 18650 셀 12개의 1,000 사이클 충방전 용량·전압·온도 이력");
    expect(battery.people.principal_investigator).toMatchObject({ display_name: "B Researcher", national_researcher_number: "10000002", affiliation: { organization_id: ORG.b, name: "Institute B" } });
    expect(battery.people.steward_contact.email).toBe("b.steward@inst-b.local"); // 2001 is contact_email_public
    expect(battery.stats).toMatchObject({ file_count: 5 });
    expect(battery.principal_investigator_id).toBeUndefined();
    const open = await getJson(USER.aResearcher, `/datasets/${DATASET.openMaterials}`);
    expect(open.people.steward_contact.email).toBeUndefined();
  });

  it("validates research fields like the API", async () => {
    const res = await send(USER.bSteward, "POST", "/datasets", { ...datasetCreate(ORG.b), principal_investigator_id: USER.aResearcher, subject_codes: ["NOPE"], temporal_start: "2025-01-02", temporal_end: "2025-01-01" });
    expect(res.status).toBe(422);
    const fields = (await res.json()).error.details.fields;
    expect(fields).toEqual(
      expect.arrayContaining([
        { field: "principal_investigator_id", reason: "PERSON_NOT_ELIGIBLE" },
        { field: "subject_codes", reason: "VOCABULARY_TERM_UNKNOWN" },
        { field: "temporal_end", reason: "TEMPORAL_RANGE" },
      ]),
    );
    const missing = await send(USER.bSteward, "POST", "/datasets", { ...datasetCreate(ORG.b), principal_investigator_id: undefined });
    expect((await missing.json()).error.details.fields).toEqual([{ field: "principal_investigator_id", reason: "Field required" }]);
    const both = await send(USER.bSteward, "PATCH", `/datasets/${DATASET.battery}`, { collecting_organization_name: "Elsewhere" });
    expect((await both.json()).error.details.fields).toEqual([{ field: "collecting_organization_name", reason: "MUTUALLY_EXCLUSIVE" }]);
    const unknownOrg = await send(USER.bSteward, "PATCH", `/datasets/${DATASET.battery}`, { collecting_organization_id: USER.admin });
    expect((await unknownOrg.json()).error.details.fields).toEqual([{ field: "collecting_organization_id", reason: "UNKNOWN_ORGANIZATION" }]);
  });

  it("clears nullable fields with null and audits metadata changes", async () => {
    const res = await send(USER.bSteward, "PATCH", `/datasets/${DATASET.battery}`, { subtitle: null, temporal_end: null, collecting_organization_id: null, collecting_organization_name: "Elsewhere" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subtitle).toBeNull();
    expect(body.temporal_end).toBeNull();
    expect(body.collecting_organization).toEqual({ organization_id: null, name: "Elsewhere" });
    expect(getDb().audit.some((e) => e.action === "DATASET_UPDATED" && e.resource.id === DATASET.battery)).toBe(true);
    // Unchanged people keep their stored affiliation; reassigning to an ineligible person is rejected.
    const bad = await send(USER.bSteward, "PATCH", `/datasets/${DATASET.battery}`, { data_steward_contact_id: USER.aSteward });
    expect((await bad.json()).error.details.fields).toEqual([{ field: "data_steward_contact_id", reason: "PERSON_NOT_ELIGIBLE" }]);
  });

  it("filters search by period overlap, subject and collecting organization", async () => {
    const recent = await getJson(USER.aResearcher, "/datasets?temporal_from=2026-01-01");
    expect(recent.items.map((h: { dataset_id: string }) => h.dataset_id)).toContain(DATASET.battery);
    expect(recent.items.map((h: { dataset_id: string }) => h.dataset_id)).not.toContain(DATASET.openMaterials);
    const bad = await send(USER.aResearcher, "GET", "/datasets?temporal_from=2026-01-02&temporal_to=2026-01-01");
    expect(bad.status).toBe(422);
    expect((await bad.json()).error.details.fields).toEqual([{ field: "temporal_to", reason: "TEMPORAL_RANGE" }]);
    const all = await getJson(USER.aResearcher, "/datasets");
    expect(all.facets.subject).toEqual(expect.arrayContaining([{ value: "MATERIALS", count: 1 }, { value: "ENERGY", count: 2 }]));
    expect(all.facets.collecting_organization_id).toEqual(expect.arrayContaining([{ value: ORG.a, count: 2, label: "Institute A" }, { value: ORG.b, count: 1, label: "Institute B" }]));
    const byPi = await getJson(USER.aResearcher, `/datasets?principal_investigator_id=${USER.bResearcher}&material=ELECTROLYTE&method=SENSOR_LOGGING`);
    expect(byPi.items.map((h: { dataset_id: string }) => h.dataset_id)).toEqual([DATASET.battery]);
    expect(byPi.items[0]).toMatchObject({ principal_investigator_name: "B Researcher", collecting_organization_name: "Institute B", subject_codes: ["ENERGY", "BATTERY"] });
    // q reaches vocabulary labels and the PI name; an open-ended period (qcLogs) overlaps later windows.
    expect((await getJson(USER.aResearcher, "/datasets?q=%EC%9E%AC%EB%A3%8C")).items.length).toBeGreaterThan(0);
    expect((await getJson(USER.bResearcher, "/datasets?temporal_from=2030-01-01")).items.map((h: { dataset_id: string }) => h.dataset_id)).toEqual([DATASET.qcLogs]);
  });

  it("puts contributors keeping affiliation, lists vocabulary, serves JSON-LD", async () => {
    const put = await send(USER.bSteward, "PUT", `/datasets/${DATASET.battery}/contributors`, { contributors: [{ user_id: USER.aResearcher, role: "CO_INVESTIGATOR" }] });
    expect(put.status).toBe(200);
    expect((await put.json()).items[0].affiliation.organization_id).toBe(ORG.a);
    const dup = await send(USER.bSteward, "PUT", `/datasets/${DATASET.battery}/contributors`, { contributors: [{ user_id: USER.bResearcher, role: "DATA_CURATOR" }, { user_id: USER.bResearcher, role: "DATA_CURATOR" }] });
    expect((await dup.json()).error.details.fields).toEqual([{ field: "contributors", reason: "DUPLICATE" }]);
    const disabled = await send(USER.bSteward, "PUT", `/datasets/${DATASET.battery}/contributors`, { contributors: [{ user_id: USER.bDisabled, role: "DATA_CURATOR" }] });
    expect((await disabled.json()).error.details.fields).toEqual([{ field: "contributors[0].user_id", reason: "PERSON_NOT_ELIGIBLE" }]);
    expect((await send(USER.bResearcher, "PUT", `/datasets/${DATASET.battery}/contributors`, { contributors: [] })).status).toBe(403);
    const vocab = await getJson(USER.aResearcher, "/vocabulary/SUBJECT");
    expect(vocab.items.length).toBeGreaterThanOrEqual(20);
    expect((await send(USER.aResearcher, "GET", "/vocabulary/NOPE")).status).toBe(422);
    const term = { code: "NEW_TERM", label_ko: "새 용어", label_en: "New term" };
    expect((await send(USER.bSteward, "POST", "/vocabulary/METHOD", term)).status).toBe(403);
    expect((await send(USER.admin, "POST", "/vocabulary/METHOD", term)).status).toBe(201);
    expect((await send(USER.admin, "POST", "/vocabulary/METHOD", term)).status).toBe(409);
    expect((await send(USER.admin, "POST", "/vocabulary/METHOD", { ...term, code: "OTHER", parent_code: "MISSING" })).status).toBe(422);
    const doc = await getJson(USER.aResearcher, `/datasets/${DATASET.battery}/metadata.jsonld`);
    expect(doc["@type"]).toEqual(["Dataset", "dcat:Dataset"]);
    expect(doc.temporalCoverage).toBe("2026-01-12/2026-06-30");
    expect(doc.about[0]).toMatchObject({ "@type": "DefinedTerm", "@id": expect.stringContaining("/vocabulary/SUBJECT/") });
  });

  it("updateMe sets the NTIS number; duplicates are 409", async () => {
    const ok = await send(USER.aAdmin, "PATCH", "/me", { national_researcher_number: "12345678" });
    expect((await ok.json()).national_researcher_number).toBe("12345678");
    expect((await send(USER.bAdmin, "PATCH", "/me", { national_researcher_number: "12345678" })).status).toBe(409);
    expect((await send(USER.bAdmin, "PATCH", "/me", { national_researcher_number: "12" })).status).toBe(422);
    expect((await send(USER.bAdmin, "PATCH", "/me", {})).status).toBe(422);
    expect((await (await send(USER.aAdmin, "PATCH", "/me", { national_researcher_number: null })).json()).national_researcher_number).toBeNull();
  });

  it("transferUserOrganization moves a user and keeps history (PLATFORM_ADMIN only)", async () => {
    expect((await send(USER.aAdmin, "POST", `/users/${USER.aResearcher}/transfer`, { organization_id: ORG.b })).status).toBe(403);
    expect((await send(USER.admin, "POST", `/users/${USER.aResearcher}/transfer`, { organization_id: USER.admin })).status).toBe(422);
    const moved = await send(USER.admin, "POST", `/users/${USER.aResearcher}/transfer`, { organization_id: ORG.b });
    expect((await moved.json()).organization_id).toBe(ORG.b);
    expect(getDb().users.find((u) => u.user_id === USER.aResearcher)?.history).toMatchObject([{ organization_id: ORG.a }]);
    const found = await getJson(USER.bAdmin, "/users?q=A%20Researcher");
    expect(found.items.map((u: { organization_id: string }) => u.organization_id)).toEqual([ORG.b]);
    // An Institute A dataset whose PI was A Researcher keeps the at-the-time affiliation and shows the new current org.
    const sensors = await getJson(USER.aSteward, `/datasets/${DATASET.sensors}`);
    expect(sensors.people.principal_investigator.affiliation.organization_id).toBe(ORG.a);
    expect(sensors.people.principal_investigator.current_organization.organization_id).toBe(ORG.b);
  });
});

describe("Data Explorer mocks (web Task 2)", () => {
  const dataFile = async (version: string, path = "data/measurements.csv") => {
    const v = await getJson(USER.bSteward, `/dataset-versions/${version}`);
    return v.files.find((f: { path: string }) => f.path === path) as { file_id: string };
  };

  it("serves file profiles to viewers and previews only with download permission (grants ignored, P6)", async () => {
    const data = await dataFile(VERSION.battery);
    const profile = await getJson(USER.aResearcher, `/dataset-files/${data.file_id}/profile`);
    expect(profile.status).toBe("READY");
    expect(JSON.stringify(profile)).not.toMatch(/top_values|histogram|"min"|"max"|S0001/);
    // a.researcher holds an ACTIVE grant, but previews ignore grants.
    const denied = await send(USER.aResearcher, "GET", `/dataset-files/${data.file_id}/preview`);
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.details.reason).toBe("DOWNLOAD_PERMISSION_REQUIRED");
    expect((await send(USER.bResearcher, "GET", `/dataset-files/${data.file_id}/preview`)).status).toBe(200);
    expect((await send(USER.admin, "GET", `/dataset-files/${data.file_id}/preview`)).status).toBe(200);
    const open = await dataFile(VERSION.openMaterials);
    expect((await send(USER.aResearcher, "GET", `/dataset-files/${open.file_id}/preview`)).status).toBe(200);
    const readme = await dataFile(VERSION.battery, "README.md");
    expect((await getJson(USER.aResearcher, `/dataset-files/${readme.file_id}/profile`)).status).toBe("UNSUPPORTED");
    expect((await send(USER.aResearcher, "GET", `/dataset-files/${crypto.randomUUID()}/profile`)).status).toBe(404);
  });

  it("captures uploaded CSVs on publish; unparseable and parquet files FAIL", async () => {
    const created = await (await send(USER.aSteward, "POST", "/datasets", datasetCreate(ORG.a))).json();
    const v = await (await send(USER.aSteward, "POST", `/datasets/${created.dataset_id}/versions`, { version_label: "v1" })).json();
    const csv = "x,y\n1,a\n2,b\n";
    const long = `x\n${"z".repeat(MiB + 10)}\n`;
    const files = [
      { path: "t.csv", body: csv },
      { path: "long.csv", body: long },
      { path: "p.parquet", body: "PAR1" },
    ];
    const session = await (
      await send(USER.aSteward, "POST", `/dataset-versions/${v.dataset_version_id}/upload-session`, {
        files: files.map((f) => ({ path: f.path, size_bytes: f.body.length, sha256: "a".repeat(64), media_type: f.path.endsWith(".parquet") ? "application/vnd.apache.parquet" : "text/csv" })),
      })
    ).json();
    for (const f of session.files) {
      const body = files.find((x) => x.path === f.path)!.body;
      await fetch(f.upload.url, { method: "PUT", body });
    }
    await send(USER.aSteward, "POST", `/upload-sessions/${session.upload_session_id}/complete`, {});
    expect((await send(USER.aSteward, "POST", `/dataset-versions/${v.dataset_version_id}/publish`)).status).toBe(200);
    const id = (path: string) => session.files.find((f: { path: string }) => f.path === path).file_id;
    const ok = await getJson(USER.aSteward, `/dataset-files/${id("t.csv")}/profile`);
    expect(ok).toMatchObject({ status: "READY", format: "csv", rows_sampled: 2 });
    const bad = await getJson(USER.aSteward, `/dataset-files/${id("long.csv")}/profile`);
    expect(bad).toMatchObject({ status: "FAILED", failure_code: "UNPARSEABLE" });
    expect((await getJson(USER.aSteward, `/dataset-files/${id("t.csv")}/preview`)).rows).toEqual([["1", "a"], ["2", "b"]]);
    expect(await getJson(USER.aSteward, `/dataset-files/${id("p.parquet")}/profile`)).toMatchObject({ status: "FAILED", failure_code: "GENERATION_FAILED" });
  });

  it("reports a tabular file without a preview row as PENDING", async () => {
    const data = await dataFile(VERSION.battery);
    delete getDb().previews[data.file_id];
    expect((await getJson(USER.aResearcher, `/dataset-files/${data.file_id}/profile`)).status).toBe("PENDING");
  });
});
