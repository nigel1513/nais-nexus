import { http, HttpResponse, delay } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { as } from "../../../tests/mock-api";
import { server } from "../../../tests/msw";
import { getDb } from "../db";
import { NOTE, PROJECT, USER } from "../fixtures";
import { seoulDate } from "../note-hash";
import { bridgeConfig, notebookRefId, resetBridge, seedNotebookActivity, settleBridgedDrafts } from "../notebook-activity";

const BASE = "http://api.test";
const ACTIVITY = `${BASE}/api/v1/internal/notes/notebook-activity`;
const DRAFT = `${BASE}/api/v1/internal/notes/draft-sections`;
const minjun = as(USER.aResearcher); // recorder of NOTE.draft (today's DRAFT in PROJECT.seed)
const yujin = as(USER.bResearcher);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const resetRequest = () => (getDb().notes.find((n) => n.note_id === NOTE.draft)!.draft_requested_at = null);

const SECTIONS_ANSWER = {
  sections: {
    OBJECTIVE: [{ text: "온도 주기 확인을 목표로 분석했다.", evidence: [{ label: "temp 분석 · 셀 1", at: "2026-10-03T01:00:00Z" }] }],
    METHOD: [],
    PROCEDURE: [
      { text: "셀 2에서 평균 온도를 계산했다.", evidence: [{ label: "temp 분석 · 셀 2", at: "2026-10-03T01:00:00Z" }] },
      { text: "   ", evidence: [] },
    ],
    RESULTS: [],
    DISCUSSION: [],
    NEXT: [{ text: "챔버 설정과 대조한다.", evidence: [] }],
    REFERENCES: [],
  },
};

describe("bridgeConfig", () => {
  it("needs both the internal api URL and the token", () => {
    expect(bridgeConfig({})).toBeNull();
    expect(bridgeConfig({ NAIS_INTERNAL_API_URL: BASE })).toBeNull();
    expect(bridgeConfig({ NAIS_INTERNAL_TOKEN: "t" })).toBeNull();
    expect(bridgeConfig({ NAIS_INTERNAL_API_URL: `${BASE}/`, NAIS_INTERNAL_TOKEN: "t" })).toEqual({ url: BASE, token: "t" });
  });

  it("derives one NOTEBOOK ref_id per notebook from the label", () => {
    const a = notebookRefId(USER.aResearcher, PROJECT.seed, "temp 분석 · 셀 1");
    expect(a).toMatch(UUID);
    expect(notebookRefId(USER.aResearcher, PROJECT.seed, "temp 분석 · 셀 7")).toBe(a);
    expect(notebookRefId(USER.aResearcher, PROJECT.seed, "다른 노트북 · 셀 1")).not.toBe(a);
  });
});

describe("notes mocks: bridge off (seeded behaviour)", () => {
  beforeEach(() => resetBridge());

  it("never calls the api and keeps the seeded stand-in", async () => {
    const calls = vi.fn();
    server.use(http.all(`${BASE}/*`, () => (calls(), HttpResponse.json({ count: 9, notebooks: [] }))));
    expect((await minjun.get(`/notes/${NOTE.draft}`)).body.draft_source_count).toBe(0);
    expect((await minjun.post(`/notes/${NOTE.draft}/draft`)).body.error.details.reason).toBe("NO_NOTEBOOK_ACTIVITY");
    seedNotebookActivity({ user_id: USER.aResearcher, project_id: PROJECT.seed, day: seoulDate(), title: "x", saved_at: new Date().toISOString(), cells: [] });
    expect((await minjun.get(`/notes/${NOTE.draft}`)).body.draft_source_count).toBe(1);
    expect(calls).not.toHaveBeenCalled();
  });
});

describe("notes mocks: bridged to the api's internal endpoints", () => {
  beforeEach(() => {
    resetBridge();
    vi.stubEnv("NAIS_INTERNAL_API_URL", BASE);
    vi.stubEnv("NAIS_INTERNAL_TOKEN", "internal-secret");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("takes draft_source_count from the real activity (token header, listings only), cached per user/project/day", async () => {
    const seen: URL[] = [];
    server.use(
      http.get(ACTIVITY, ({ request }) => {
        expect(request.headers.get("x-nais-internal-token")).toBe("internal-secret");
        seen.push(new URL(request.url));
        return HttpResponse.json({ count: 2, notebooks: [] });
      }),
    );
    expect((await minjun.get(`/notes/${NOTE.draft}`)).body.draft_source_count).toBe(2);
    expect((await minjun.get(`/notes/${NOTE.draft}`)).body.draft_source_count).toBe(2);
    expect(seen).toHaveLength(1); // the second read used the 10 s cache
    expect(Object.fromEntries(seen[0]!.searchParams)).toEqual({ user_id: USER.aResearcher, project_id: PROJECT.seed, day: seoulDate() });
    // Other readers never trigger a call and see 0 (draft_source_count is the recorder's).
    expect((await minjun.get(`/notes/${NOTE.signed}`)).body.draft_source_count).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it("falls back to 0 when Jupyter or the api fails, and draftNote answers 503 DEPENDENCY_UNAVAILABLE", async () => {
    server.use(http.get(ACTIVITY, () => HttpResponse.json({ error: { code: "DEPENDENCY_UNAVAILABLE", message: "x", trace_id: "t" } }, { status: 503 })));
    expect((await minjun.get(`/notes/${NOTE.draft}`)).body.draft_source_count).toBe(0);
    const res = await minjun.post(`/notes/${NOTE.draft}/draft`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("DEPENDENCY_UNAVAILABLE");
  });

  it("gives up on a slow activity call after 2 s (count 0)", async () => {
    server.use(
      http.get(ACTIVITY, async () => {
        await delay(3_000);
        return HttpResponse.json({ count: 5, notebooks: [] });
      }),
    );
    const started = Date.now();
    expect((await minjun.get(`/notes/${NOTE.draft}`)).body.draft_source_count).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_900);
  });

  it("answers 422 NO_NOTEBOOK_ACTIVITY when the real count is 0", async () => {
    server.use(http.get(ACTIVITY, () => HttpResponse.json({ count: 0, notebooks: [] })));
    const res = await minjun.post(`/notes/${NOTE.draft}/draft`);
    expect(res.status).toBe(422);
    expect(res.body.error.details.reason).toBe("NO_NOTEBOOK_ACTIVITY");
  });

  it("drafts through draft-sections: RUNNING until the answer, then unaccepted AI blocks with NOTEBOOK evidence", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const requests: unknown[] = [];
    server.use(
      http.get(ACTIVITY, () => HttpResponse.json({ count: 1, notebooks: [{ title: "temp 분석", saved_at: "2026-10-03T01:00:00Z", cell_count: null }] })),
      http.post(DRAFT, async ({ request }) => {
        expect(request.headers.get("x-nais-internal-token")).toBe("internal-secret");
        requests.push(await request.json());
        await gate;
        return HttpResponse.json(SECTIONS_ANSWER);
      }),
    );
    const before = (await minjun.get(`/notes/${NOTE.draft}`)).body;
    const started = await minjun.post(`/notes/${NOTE.draft}/draft`);
    expect(started.status).toBe(202);
    expect(started.body.draft_status).toBe("RUNNING");
    expect((await minjun.get(`/notes/${NOTE.draft}`)).body.draft_status).toBe("RUNNING"); // reads do not advance a bridged draft
    expect((await minjun.post(`/notes/${NOTE.draft}/draft`)).body.error.code).toBe("RATE_LIMITED");
    release();
    await settleBridgedDrafts();
    expect(requests).toEqual([{ user_id: USER.aResearcher, project_id: PROJECT.seed, day: seoulDate(), project_name: "차세대 이차전지 소재 공동연구" }]);
    const done = (await minjun.get(`/notes/${NOTE.draft}`)).body;
    expect(done).toMatchObject({ draft_status: "DONE", draft_error: null, revision: before.revision + 1 });
    const ai = done.blocks.filter((b: { origin: string }) => b.origin === "AI");
    expect(ai.map((b: { section: string; text: string; accepted: boolean }) => [b.section, b.text, b.accepted])).toEqual([
      ["OBJECTIVE", "온도 주기 확인을 목표로 분석했다.", false],
      ["PROCEDURE", "셀 2에서 평균 온도를 계산했다.", false],
      ["NEXT", "챔버 설정과 대조한다.", false],
    ]);
    const ref = notebookRefId(USER.aResearcher, PROJECT.seed, "temp 분석");
    expect(ai[0].evidence).toEqual([{ type: "NOTEBOOK", ref_id: ref, label: "temp 분석 · 셀 1", at: "2026-10-03T01:00:00Z" }]);
    expect(ai[1].evidence[0].ref_id).toBe(ref);
    expect(ai[2].evidence).toEqual([]);
    // Drafting the same day again appends nothing new.
    resetRequest();
    await minjun.post(`/notes/${NOTE.draft}/draft`);
    await settleBridgedDrafts();
    expect((await minjun.get(`/notes/${NOTE.draft}`)).body.blocks).toHaveLength(done.blocks.length);
    expect((await yujin.get(`/notes/${NOTE.draft}`)).status).toBe(404);
  });

  it("ends FAILED with a Korean draft_error when the LLM is unavailable", async () => {
    server.use(
      http.get(ACTIVITY, () => HttpResponse.json({ count: 1, notebooks: [] })),
      http.post(DRAFT, () => HttpResponse.json({ error: { code: "LLM_UNAVAILABLE", message: "x", trace_id: "t" } }, { status: 503 })),
    );
    expect((await minjun.post(`/notes/${NOTE.draft}/draft`)).status).toBe(202);
    await settleBridgedDrafts();
    const failed = (await minjun.get(`/notes/${NOTE.draft}`)).body;
    expect(failed).toMatchObject({ draft_status: "FAILED", draft_error: "로컬 LLM에 연결할 수 없습니다. 잠시 후 다시 시도하세요." });
    expect(failed.blocks.every((b: { origin: string }) => b.origin === "HUMAN")).toBe(true);
  });

  it("maps a late 422 NO_NOTEBOOK_ACTIVITY and network failures to FAILED", async () => {
    server.use(
      http.get(ACTIVITY, () => HttpResponse.json({ count: 1, notebooks: [] })),
      http.post(DRAFT, () => HttpResponse.json({ error: { code: "VALIDATION_FAILED", message: "x", trace_id: "t", details: { reason: "NO_NOTEBOOK_ACTIVITY" } } }, { status: 422 })),
    );
    await minjun.post(`/notes/${NOTE.draft}/draft`);
    await settleBridgedDrafts();
    expect((await minjun.get(`/notes/${NOTE.draft}`)).body).toMatchObject({ draft_status: "FAILED", draft_error: "오늘 저장한 노트북이 없습니다." });
    server.use(http.post(DRAFT, () => HttpResponse.error()));
    resetRequest();
    await minjun.post(`/notes/${NOTE.draft}/draft`);
    await settleBridgedDrafts();
    expect((await minjun.get(`/notes/${NOTE.draft}`)).body).toMatchObject({ draft_status: "FAILED", draft_error: "초안을 만들지 못했습니다. 잠시 후 다시 시도하세요." });
  });
});
