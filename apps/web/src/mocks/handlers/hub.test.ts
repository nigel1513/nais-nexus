import { describe, expect, it } from "vitest";
import { as } from "../../../tests/mock-api";
import { DATASET, ORG, PROJECT, THREAD, USER } from "../fixtures";

const minjun = as(USER.aResearcher); // member of the seed project (한국에너지기술연구원)
const hyunwoo = as(USER.bSteward); // 한국재료연구원 steward, not a member

type Card = { dataset_id: string; metric: number | null };

describe("hub mocks", () => {
  it("builds the overview from datasets the caller can see", async () => {
    const res = await minjun.get("/hub/overview");
    expect(res.status).toBe(200);
    const { rails, organizations } = res.body;
    expect(rails.most_used.map((c: Card) => [c.dataset_id, c.metric])).toEqual(expect.arrayContaining([[DATASET.battery, 1], [DATASET.openMaterials, 1]]));
    expect(rails.recent.every((c: Card) => c.metric === null)).toBe(true);
    const all = [...rails.trending, ...rails.recent, ...rails.most_used].map((c: Card) => c.dataset_id);
    expect(all).not.toContain(DATASET.qcLogs); // INTERNAL dataset of another organization
    const b = organizations.find((o: { organization_id: string }) => o.organization_id === ORG.b);
    expect(b).toMatchObject({ name: "한국재료연구원", dataset_count: 2, public_count: 1, controlled_count: 1 });
    const own = (await hyunwoo.get("/hub/overview")).body.organizations.find((o: { organization_id: string }) => o.organization_id === ORG.b);
    expect(own.dataset_count).toBe(3);
  });

  it("ranks trending by access requests of the last 7 days", async () => {
    const created = await as(USER.bResearcher).post("/access-requests", {
      dataset_id: DATASET.sensors,
      project_id: PROJECT.seed,
      purpose: "ACADEMIC_RESEARCH",
      purpose_detail: "공조 설비 센서와 셀 온도의 상관을 확인하기 위한 요청입니다.",
      operations: ["READ"],
      requested_days: 30,
    });
    expect(created.status).toBe(201);
    const trending = (await minjun.get("/hub/overview")).body.rails.trending as Card[];
    expect(trending.find((c) => c.dataset_id === DATASET.sensors)?.metric).toBeGreaterThanOrEqual(1);
  });

  it("lists projects using a dataset; non-members only see the hidden count", async () => {
    const member = await minjun.get(`/datasets/${DATASET.battery}/projects`);
    expect(member.body).toEqual({ items: [expect.objectContaining({ project_id: PROJECT.seed, name: "차세대 이차전지 소재 공동연구", lead_organization_name: "한국에너지기술연구원" })], hidden_count: 0 });
    expect((await hyunwoo.get(`/datasets/${DATASET.battery}/projects`)).body).toEqual({ items: [], hidden_count: 1 });
    expect((await minjun.get(`/datasets/${DATASET.qcLogs}/projects`)).status).toBe(404);
  });

  it("reveals project details in the activity only to project members", async () => {
    const member = (await minjun.get(`/datasets/${DATASET.battery}/activity`)).body.items;
    const types = member.map((a: { type: string }) => a.type);
    expect(types).toEqual(expect.arrayContaining(["VERSION_PUBLISHED", "USED_IN_PROJECT", "DISCUSSION_STARTED"]));
    expect(member.find((a: { type: string }) => a.type === "USED_IN_PROJECT")).toMatchObject({ label: "차세대 이차전지 소재 공동연구", project_id: PROJECT.seed, actor_display_name: "김민준" });
    const outsider = (await hyunwoo.get(`/datasets/${DATASET.battery}/activity`)).body.items;
    expect(outsider.find((a: { type: string }) => a.type === "USED_IN_PROJECT")).toMatchObject({ label: null, project_id: null, ref_id: null, actor_display_name: null });
    expect(outsider.find((a: { type: string }) => a.type === "DISCUSSION_STARTED")).toMatchObject({ label: "C07 셀 온도 기록 확인 요청", ref_id: THREAD.dataset });
    const dates = member.map((a: { occurred_at: string }) => a.occurred_at);
    expect(dates).toEqual([...dates].sort().reverse());
    expect((await minjun.get(`/datasets/${DATASET.battery}/activity?limit=2`)).body.page.has_more).toBe(true);
  });
});
