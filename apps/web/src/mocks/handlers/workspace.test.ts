import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { as } from "../../../tests/mock-api";
import { getDb } from "../db";
import { DATASET, GRANT, INPUT, ORG, OUTPUT, PROJECT, RECIPE, USER, VERSION } from "../fixtures";

const P = `/projects/${PROJECT.seed}`;
const minjun = as(USER.aResearcher); // PROJECT_OWNER, 한국에너지기술연구원 (lead), holds the battery grant
const yujin = as(USER.bResearcher); // RESEARCHER, 한국재료연구원 (owns battery and open materials)
const seoyeon = as(USER.aSteward); // DATA_STEWARD of 한국에너지기술연구원, not a member
const hyunwoo = as(USER.bSteward); // DATA_STEWARD of 한국재료연구원, not a member

async function revokeBatteryGrant() {
  const res = await hyunwoo.post(`/access-grants/${GRANT.seed}/revoke`, { reason: "과제 종료" });
  expect(res.status).toBe(200);
}

async function upload(user: ReturnType<typeof as>, name: string, content: string, access_level = "CONTROLLED") {
  const sha256 = createHash("sha256").update(content).digest("hex");
  const session = await user.post(`${P}/outputs`, { title: `${name} 결과`, access_level, files: [{ name, size_bytes: Buffer.byteLength(content), sha256, media_type: "text/csv" }] });
  expect(session.status, JSON.stringify(session.body)).toBe(201);
  return session.body as { output_id: string; files: { name: string; upload: { url: string } }[] };
}

describe("workspace mocks: inputs", () => {
  it("lists the seed inputs with the newer version and the caller's access", async () => {
    const res = await minjun.get(`${P}/inputs`);
    expect(res.status).toBe(200);
    const battery = res.body.items.find((i: { input_id: string }) => i.input_id === INPUT.battery);
    expect(battery).toMatchObject({ dataset_id: DATASET.battery, version_label: "v1.1", newer_version_label: "v2.0", access_level: "CONTROLLED", access_lapsed: false, added_by_display_name: "김민준" });
    expect(res.body.items).toHaveLength(2);
    expect((await seoyeon.get(`${P}/inputs`)).status).toBe(404);
  });

  it("needs an active grant for non-public datasets of another organization (403 ACCESS_REQUIRED)", async () => {
    const denied = await yujin.post(`${P}/inputs`, { dataset_id: DATASET.sensors });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatchObject({ code: "ACCESS_REQUIRED", details: { dataset_id: DATASET.sensors } });
    // the recorder's own organization owns the sensor stream: no grant needed
    const own = await minjun.post(`${P}/inputs`, { dataset_id: DATASET.sensors, note: "공조 비교" });
    expect(own.status).toBe(201);
    expect(own.body).toMatchObject({ version_label: "v1", access_lapsed: false, note: "공조 비교" });
    expect((await minjun.post(`${P}/inputs`, { dataset_id: DATASET.sensors })).body.error.code).toBe("CONFLICT");
    expect((await seoyeon.post(`${P}/inputs`, { dataset_id: DATASET.sensors })).body.error.code).toBe("FORBIDDEN");
    // an unpublished dataset of another organization is not visible at all
    expect((await yujin.post(`${P}/inputs`, { dataset_id: DATASET.electrolyte })).status).toBe(404);
    expect((await minjun.post(`${P}/inputs`, { dataset_id: DATASET.battery, dataset_version_id: VERSION.batteryDraft })).body.error.code).toBe("DATASET_VERSION_NOT_PUBLISHED");
  });

  it("re-checks access when the pinned version changes and audits the change", async () => {
    await revokeBatteryGrant();
    const denied = await minjun.patch(`${P}/inputs/${INPUT.battery}`, { dataset_version_id: VERSION.battery });
    expect(denied.body.error.code).toBe("ACCESS_REQUIRED");
    const ok = await yujin.patch(`${P}/inputs/${INPUT.battery}`, { dataset_version_id: VERSION.battery });
    expect(ok.body).toMatchObject({ version_label: "v2.0", newer_version_label: null });
    expect(getDb().audit.some((e) => e.action === "PROJECT_INPUT_VERSION_CHANGED" && e.resource.id === INPUT.battery)).toBe(true);
    expect((await yujin.patch(`${P}/inputs/${INPUT.battery}`, { dataset_version_id: VERSION.batteryDraft })).body.error.code).toBe("DATASET_VERSION_NOT_PUBLISHED");
  });

  it("marks inputs access_lapsed after a revocation and blocks preview, run, download and publish (409 INPUT_ACCESS_LAPSED)", async () => {
    await revokeBatteryGrant();
    const inputs = (await minjun.get(`${P}/inputs`)).body.items;
    expect(inputs.find((i: { input_id: string }) => i.input_id === INPUT.battery).access_lapsed).toBe(true);
    expect((await yujin.get(`${P}/inputs`)).body.items.every((i: { access_lapsed: boolean }) => !i.access_lapsed)).toBe(true);
    for (const res of [
      await minjun.post(`${P}/recipes/${RECIPE.capacity}/preview`, {}),
      await minjun.post(`${P}/recipes/${RECIPE.capacity}/runs`),
      await minjun.post(`${P}/outputs/${OUTPUT.capacity}/download`),
      await minjun.post(`${P}/outputs/${OUTPUT.capacity}/publish-requests`, {}),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: "INPUT_ACCESS_LAPSED", details: { input_ids: [INPUT.battery] } });
    }
    // the battery owner's own researcher is unaffected
    expect((await yujin.post(`${P}/outputs/${OUTPUT.capacity}/download`)).status).toBe(201);
  });

  it("soft-removes an input; recipes still naming it fail validation", async () => {
    expect((await minjun.delete(`${P}/inputs/${INPUT.battery}`)).status).toBe(204);
    expect((await minjun.get(`${P}/inputs`)).body.items.map((i: { input_id: string }) => i.input_id)).toEqual([INPUT.openMaterials]);
    const res = await minjun.post(`${P}/recipes/${RECIPE.capacity}/runs`);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: "RECIPE_INVALID", details: { step_index: null, reason: "UNKNOWN_INPUT", input_id: INPUT.battery } });
  });
});

describe("workspace mocks: request validation order", () => {
  it("rejects malformed bodies (422) before the membership check, as the API validates the request first", async () => {
    expect((await seoyeon.post(`${P}/inputs`, {})).body.error).toMatchObject({ code: "VALIDATION_FAILED", details: { fields: [{ field: "dataset_id", reason: "MISSING" }] } });
    expect((await seoyeon.patch(`${P}/inputs/${INPUT.battery}`, {})).body.error.code).toBe("VALIDATION_FAILED");
    expect((await seoyeon.post(`${P}/recipes`, { name: "", input_ids: [INPUT.battery], steps: [] })).body.error.code).toBe("VALIDATION_FAILED");
    expect((await seoyeon.post(`${P}/inputs`, { dataset_id: DATASET.sensors })).body.error.code).toBe("FORBIDDEN");
  });
});

describe("workspace mocks: recipes and runs", () => {
  it("previews the seed recipe on the pinned CSV (first 100 rows of the result)", async () => {
    const res = await yujin.post(`${P}/recipes/${RECIPE.capacity}/preview`, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ header: ["cycle", "capacity_ah", "temp_c"], rows_truncated: true, input_rows_read: 500, output_rows: 300 });
    expect(res.body.rows).toHaveLength(100);
    expect(res.body.rows[0]).toEqual(["1", "3050.0", "24.0"]);
    // unsaved steps from the body
    const agg = await yujin.post(`${P}/recipes/${RECIPE.capacity}/preview`, { steps: [{ type: "aggregate", group_by: [], metrics: [{ column: "cycle", fn: "count" }, { column: "temp_c", fn: "max" }] }] });
    expect(agg.body).toMatchObject({ header: ["cycle_count", "temp_c_max"], rows: [["500", "26.8"]], output_rows: 1 });
  });

  it("validates steps against the inputs' columns (422 RECIPE_INVALID with step_index)", async () => {
    const base = { name: "검증", input_ids: [INPUT.battery] };
    const unknown = await minjun.post(`${P}/recipes`, { ...base, steps: [{ type: "select_columns", columns: ["cycle", "nope"] }] });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error).toMatchObject({ code: "RECIPE_INVALID", details: { step_index: 0, reason: "UNKNOWN_COLUMN", column: "nope" } });
    const mismatch = await minjun.post(`${P}/recipes`, { ...base, input_ids: [INPUT.openMaterials], steps: [{ type: "limit", n: 5 }, { type: "aggregate", group_by: ["material"], metrics: [{ column: "sample_id", fn: "sum" }] }] });
    expect(mismatch.body.error.details).toMatchObject({ step_index: 1, reason: "TYPE_MISMATCH", column: "sample_id" });
    const join = await minjun.post(`${P}/recipes`, { ...base, steps: [{ type: "join", right_input_id: INPUT.openMaterials, on: ["cycle"], how: "inner" }] });
    expect(join.body.error.details).toMatchObject({ step_index: 0, reason: "UNKNOWN_INPUT", input_id: INPUT.openMaterials });
    const shape = await minjun.post(`${P}/recipes`, { ...base, steps: [{ type: "limit", n: 0 }] });
    expect(shape.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("saves new versions under If-Match and refuses stale saves (409 CONFLICT)", async () => {
    const current = (await minjun.get(`${P}/recipes/${RECIPE.capacity}`)).body;
    const write = { name: current.name, input_ids: current.input_ids, steps: [...current.steps, { type: "limit", n: 50 }] };
    const saved = await minjun.put(`${P}/recipes/${RECIPE.capacity}`, write, { "if-match": '"1"' });
    expect(saved.body).toMatchObject({ version: 2, updated_by: USER.aResearcher });
    const stale = await yujin.put(`${P}/recipes/${RECIPE.capacity}`, write, { "if-match": "1" });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: "CONFLICT", details: { current_version: 2 } });
    expect((await minjun.put(`${P}/recipes/${RECIPE.capacity}`, write)).status).toBe(422);
  });

  it("runs asynchronously: QUEUED → RUNNING → SUCCEEDED with a derived output and lineage", async () => {
    const started = await yujin.post(`${P}/recipes/${RECIPE.capacity}/runs`);
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ status: "QUEUED", recipe_version: 1, started_by: USER.bResearcher, output_id: null });
    expect((await yujin.post(`${P}/recipes/${RECIPE.capacity}/runs`)).body.error.code).toBe("RUN_NOT_ALLOWED");
    expect((await minjun.delete(`${P}/recipes/${RECIPE.capacity}`)).body.error.code).toBe("RUN_NOT_ALLOWED");
    const runPath = `${P}/runs/${started.body.run_id}`;
    expect((await yujin.get(runPath)).body.status).toBe("RUNNING");
    const done = (await yujin.get(runPath)).body;
    expect(done).toMatchObject({ status: "SUCCEEDED", input_rows: 500, output_rows: 300, error: null });
    const output = (await yujin.get(`${P}/outputs/${done.output_id}`)).body;
    expect(output).toMatchObject({
      kind: "DERIVED_DATASET",
      title: "용량 유지율 추이 (사이클 1~300) (v1)",
      access_level: "CONTROLLED",
      produced_by_run_id: done.run_id,
      lineage: { inputs: [{ dataset_id: DATASET.battery, version_label: "v1.1" }], recipe_id: RECIPE.capacity, recipe_version: 1, run_id: done.run_id },
      publish_status: "NONE",
    });
    expect(output.files[0]).toMatchObject({ name: "result.parquet", media_type: "application/vnd.apache.parquet" });
    expect((await yujin.get(`${P}/runs?status=SUCCEEDED&recipe_id=${RECIPE.capacity}`)).body.items).toHaveLength(2);
    expect((await minjun.delete(`${P}/recipes/${RECIPE.capacity}`)).status).toBe(204);
  });

  it("fails a run whose starter lost access before the worker picked it up", async () => {
    const started = await minjun.post(`${P}/recipes/${RECIPE.capacity}/runs`);
    await revokeBatteryGrant();
    await minjun.get(`${P}/runs/${started.body.run_id}`);
    const failed = (await minjun.get(`${P}/runs/${started.body.run_id}`)).body;
    expect(failed).toMatchObject({ status: "FAILED", output_id: null });
    expect(failed.error).toMatch(/^INPUT_ACCESS_LAPSED: /);
    expect(getDb().notifications.some((n) => n.user_id === USER.aResearcher && n.type === "RUN_FAILED")).toBe(true);
  });
});

describe("workspace mocks: outputs and hub publication", () => {
  it("keeps uploads at or above the strictest input level and re-checks size and sha256 on completion", async () => {
    const loose = await minjun.post(`${P}/outputs`, { title: "공개 시도", access_level: "PUBLIC", files: [{ name: "a.csv", size_bytes: 1, sha256: "a".repeat(64), media_type: "text/csv" }] });
    expect(loose.status).toBe(422);
    expect(loose.body.error).toMatchObject({ code: "VALIDATION_FAILED", details: { field: "access_level", minimum: "CONTROLLED" } });

    const session = await upload(minjun, "summary.csv", "cycle,capacity\n1,3.05\n");
    const complete = `${P}/outputs/${session.output_id}/complete`;
    expect((await minjun.post(complete)).body.error).toMatchObject({ code: "UPLOAD_CHECKSUM_MISMATCH", details: { files: [{ name: "summary.csv", reason: "MISSING" }] } });
    await fetch(session.files[0]!.upload.url, { method: "PUT", body: "cycle,capacity\n1,3.06\n" });
    expect((await minjun.post(complete)).body.error.details.files[0].reason).toBe("SHA256_MISMATCH");
    expect((await yujin.post(complete)).body.error.code).toBe("FORBIDDEN");
    expect((await minjun.get(`${P}/outputs/${session.output_id}`)).status).toBe(404); // sessions are never listed
    await fetch(session.files[0]!.upload.url, { method: "PUT", body: "cycle,capacity\n1,3.05\n" });
    const done = await minjun.post(complete);
    expect(done.body).toMatchObject({ kind: "FILE", access_level: "CONTROLLED", produced_by_run_id: null, lineage: { recipe_id: null, run_id: null } });
    expect(done.body.lineage.inputs.map((i: { dataset_id: string }) => i.dataset_id)).toEqual([DATASET.battery, DATASET.openMaterials]);
    expect((await minjun.get(`${P}/outputs?kind=FILE`)).body.items.map((o: { output_id: string }) => o.output_id)).toEqual([session.output_id]);
  });

  it("serves the stored bytes of an output, matching its size and sha256", async () => {
    const check = async (outputId: string) => {
      const download = await minjun.post(`${P}/outputs/${outputId}/download`);
      expect(download.status).toBe(201);
      const file = download.body.files[0];
      const bytes = Buffer.from(await (await fetch(file.url)).arrayBuffer());
      expect(bytes.length).toBe(file.size_bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
      return bytes.toString("utf8");
    };
    const seed = await check(OUTPUT.capacity);
    expect(seed.split("\n")[0]).toBe("cycle,capacity_ah,temp_c");
    expect(seed.split("\n")).toHaveLength(301);
    expect(seed).not.toMatch(/mock/i);
    const started = await minjun.post(`${P}/recipes/${RECIPE.capacity}/runs`);
    await minjun.get(`${P}/runs/${started.body.run_id}`);
    const run = (await minjun.get(`${P}/runs/${started.body.run_id}`)).body;
    expect(await check(run.output_id)).toBe(seed);
  });

  it("publishes through owner review: one slot per input owner plus the lead organization, no self-decision", async () => {
    const req = await minjun.post(`${P}/outputs/${OUTPUT.capacity}/publish-requests`, { title: "용량 유지율 추이 파생 데이터" });
    expect(req.status).toBe(201);
    expect(req.body.approvals.map((a: { organization_id: string }) => a.organization_id)).toEqual([ORG.b, ORG.a]);
    expect((await minjun.post(`${P}/outputs/${OUTPUT.capacity}/publish-requests`, {})).body.error.code).toBe("OUTPUT_PUBLISH_PENDING");
    const decide = `/publish-requests/${req.body.request_id}/decision`;
    expect((await yujin.post(decide, { decision: "APPROVE" })).body.error.code).toBe("FORBIDDEN");
    expect((await as(USER.admin).post(decide, { decision: "APPROVE" })).status).toBe(404);
    expect((await hyunwoo.post(decide, { decision: "REJECT" })).body.error.code).toBe("VALIDATION_FAILED");
    const partial = await hyunwoo.post(decide, { decision: "APPROVE" });
    expect(partial.body.status).toBe("PENDING");
    expect((await hyunwoo.post(decide, { decision: "APPROVE" })).body.error.code).toBe("CONFLICT");
    expect((await as(USER.aSteward).get("/publish-requests?role=reviewer&status=PENDING")).body.items).toHaveLength(1);
    const approved = await seoyeon.post(decide, { decision: "APPROVE", comment: "공개 동의" });
    expect(approved.body).toMatchObject({ status: "APPROVED", published_dataset_id: null });

    const listed = (await minjun.get(`/publish-requests?project_id=${PROJECT.seed}`)).body.items[0];
    expect(listed.published_dataset_id).toBeTruthy();
    expect((await minjun.get(`${P}/outputs/${OUTPUT.capacity}`)).body.publish_status).toBe("PUBLISHED");
    const ds = getDb().datasets.find((d) => d.dataset_id === listed.published_dataset_id)!;
    expect(ds).toMatchObject({ owner_organization_id: ORG.a, title: "용량 유지율 추이 파생 데이터", access_level: "CONTROLLED" });
    expect(ds.provenance).toContain("리튬이온 배터리 셀 사이클 시험 데이터@v1.1");
    expect(getDb().notifications.some((n) => n.user_id === USER.aResearcher && n.type === "OUTPUT_PUBLISH_DECIDED")).toBe(true);
  });

  it("forbids the requester from deciding their own request", async () => {
    // 정현우 (DATA_STEWARD of the battery owner) joins the project and asks for publication himself.
    expect((await minjun.post(`${P}/members`, { user_id: USER.bSteward, role: "RESEARCHER" })).status).toBe(201);
    const req = await hyunwoo.post(`${P}/outputs/${OUTPUT.capacity}/publish-requests`, {});
    expect(req.status).toBe(201);
    const self = await hyunwoo.post(`/publish-requests/${req.body.request_id}/decision`, { decision: "APPROVE" });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe("FORBIDDEN");
  });

  it("turns a publication the catalog cannot verify into REJECTED with failure_reason; the output may be requested again", async () => {
    const session = await upload(yujin, "corrupt-cells.csv", "cycle,temp_c\n296,26.45\n");
    await fetch(session.files[0]!.upload.url, { method: "PUT", body: "cycle,temp_c\n296,26.45\n" });
    expect((await yujin.post(`${P}/outputs/${session.output_id}/complete`)).status).toBe(200);
    const req = await yujin.post(`${P}/outputs/${session.output_id}/publish-requests`, { title: "temp_c 상승 구간" });
    await seoyeon.post(`/publish-requests/${req.body.request_id}/decision`, { decision: "APPROVE" });
    // 최유진 (한국재료연구원) requested: 정현우 of the same organization may still decide the 한국재료연구원 slot.
    expect((await hyunwoo.post(`/publish-requests/${req.body.request_id}/decision`, { decision: "APPROVE" })).body.status).toBe("APPROVED");
    const after = (await yujin.get(`/publish-requests?status=REJECTED`)).body.items[0];
    expect(after).toMatchObject({ request_id: req.body.request_id, status: "REJECTED", published_dataset_id: null });
    expect(after.failure_reason).toBe("카탈로그 파일 검증에 실패했습니다. 산출물 파일을 확인한 뒤 다시 요청하세요.");
    expect((await yujin.get(`${P}/outputs/${session.output_id}`)).body.publish_status).toBe("REJECTED");
    expect((await yujin.post(`${P}/outputs/${session.output_id}/publish-requests`, {})).status).toBe(201);
  });
});

describe("workspace mocks: discussions", () => {
  it("needs a selector, hides project threads from non-members and opens dataset threads to anyone who sees the dataset", async () => {
    expect((await minjun.get("/threads")).body.error.code).toBe("VALIDATION_FAILED");
    expect((await minjun.get(`/threads?project_id=${PROJECT.seed}`)).body.items).toHaveLength(1);
    expect((await seoyeon.get(`/threads?project_id=${PROJECT.seed}`)).status).toBe(404);
    const datasetThreads = await seoyeon.get(`/threads?scope=DATASET&target_id=${DATASET.battery}`);
    expect(datasetThreads.body.items[0]).toMatchObject({ title: "temp_c 주기적 상승 구간 확인 요청", project_id: null, created_by_display_name: "김민준" });

    const created = await seoyeon.post("/threads", { scope: "DATASET", target_id: DATASET.battery, title: "단위 문의", body: "temp_c 단위가 섭씨인가요?" });
    expect(created.status).toBe(201);
    expect(getDb().notifications.some((n) => n.user_id === USER.bSteward && n.type === "DATASET_COMMENT_ADDED")).toBe(true);
    expect((await minjun.patch(`/threads/${created.body.thread_id}`, { resolved: true })).body.error.code).toBe("FORBIDDEN");
    expect((await hyunwoo.patch(`/threads/${created.body.thread_id}`, { resolved: true })).body.resolved).toBe(true);
    const comment = await minjun.post(`/threads/${created.body.thread_id}/comments`, { body: "같은 질문입니다." });
    expect(comment.body).toMatchObject({ author_display_name: "김민준" });
    const comments = (await seoyeon.get(`/threads/${created.body.thread_id}/comments`)).body.items;
    expect(comments.map((c: { body: string }) => c.body)).toEqual(["temp_c 단위가 섭씨인가요?", "같은 질문입니다."]);
  });
});
