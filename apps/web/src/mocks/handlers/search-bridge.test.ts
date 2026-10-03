import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { as } from "../../../tests/mock-api";
import { server } from "../../../tests/msw";
import { getDb } from "../db";
import { DATASET, ORG, USER } from "../fixtures";
import { resetSearchBridge } from "../search-bridge";

const BASE = "http://api.test";
const DATASETS = `${BASE}/api/v1/internal/demo/datasets`;
const PROJECTS = `${BASE}/api/v1/internal/demo/projects`;
const minjun = as(USER.aResearcher);

const emptyFacets = { access_level: [], owner_organization_id: [], purpose: [], keyword: [], readiness_status: [] };
const hit = (dataset_id: string, title: string) => ({
  dataset_id,
  title,
  snippet: "의미로 찾은 구절",
  owner_organization_id: ORG.b,
  access_level: "CONTROLLED",
  keywords: [],
  allowed_purposes: [],
  latest_version_label: "v1",
  readiness_overall: "PASS",
  updated_at: "2026-10-01T00:00:00Z",
});

describe("search mocks: bridge off", () => {
  beforeEach(() => resetSearchBridge());

  it("matches substrings here and never calls the api", async () => {
    const calls = vi.fn();
    server.use(http.all(`${BASE}/*`, () => (calls(), HttpResponse.json({}))));
    const res = await minjun.get("/datasets?q=battery");
    expect(res.status).toBe(200);
    expect(calls).not.toHaveBeenCalled();
  });
});

describe("search mocks: bridged to the api's demo indexes", () => {
  beforeEach(() => {
    resetSearchBridge();
    vi.stubEnv("NAIS_INTERNAL_API_URL", BASE);
    vi.stubEnv("NAIS_INTERNAL_TOKEN", "internal-secret");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("a dataset text search syncs the demo catalogue once and returns the engine's answer", async () => {
    const synced: { documents: Record<string, unknown>[] }[] = [];
    const searched: Record<string, unknown>[] = [];
    server.use(
      http.put(DATASETS, async ({ request }) => {
        expect(request.headers.get("X-NAIS-Internal-Token")).toBe("internal-secret");
        synced.push((await request.json()) as { documents: Record<string, unknown>[] });
        return HttpResponse.json({ indexed: synced.at(-1)!.documents.length, removed: 0 });
      }),
      http.post(`${DATASETS}/search`, async ({ request }) => {
        searched.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ items: [hit(DATASET.battery, "리튬이온 배터리 셀 사이클 시험 데이터")], page: { next_cursor: null, has_more: false }, total: 1, facets: emptyFacets });
      }),
    );
    const res = await minjun.get("/datasets?q=fuel%20cell&access_level=CONTROLLED&limit=5");
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { dataset_id: string }) => i.dataset_id)).toEqual([DATASET.battery]);
    expect(res.body.items[0].snippet).toBe("의미로 찾은 구절");
    expect(searched[0]).toMatchObject({ viewer: { organization_id: ORG.a, platform_admin: false }, q: "fuel cell", access_level: ["CONTROLLED"], limit: 5 });

    // Every demo dataset goes in as an index document: public metadata, no file paths or storage addresses.
    const docs = synced[0]!.documents;
    expect(docs).toHaveLength(getDb().datasets.length);
    const doc = docs.find((d) => d.dataset_id === DATASET.battery)!;
    expect(doc).toMatchObject({ status: "ACTIVE", has_published_version: true, owner_organization_id: ORG.b });
    expect(JSON.stringify(docs)).not.toMatch(/storage|s3:|object_key|sha256/i);

    await minjun.get("/datasets?q=fuel%20cell");
    expect(synced).toHaveLength(1); // unchanged catalogue: no second sync
    expect(searched).toHaveLength(2);

    // No text: filters and browsing stay local.
    await minjun.get("/datasets?access_level=CONTROLLED");
    expect(searched).toHaveLength(2);
  });

  it("falls back to substring matching when the api is down, without retrying on every request", async () => {
    const calls = vi.fn();
    server.use(http.all(`${BASE}/*`, () => (calls(), HttpResponse.json({ error: { code: "DEPENDENCY_UNAVAILABLE", message: "down" } }, { status: 503 }))));
    const title = getDb().datasets.find((d) => d.dataset_id === DATASET.battery)!.title;
    const res = await minjun.get(`/datasets?q=${encodeURIComponent(title.slice(0, 4))}`);
    expect(res.status).toBe(200);
    expect(res.body.items.some((i: { dataset_id: string }) => i.dataset_id === DATASET.battery)).toBe(true);
    await minjun.get("/datasets?q=x");
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("a public project search ranks through the demo project index with the public summary fields only", async () => {
    const db = getDb();
    db.projects.find((p) => p.status === "ACTIVE")!.visibility = "PUBLIC";
    const open = db.projects.filter((p) => p.visibility === "PUBLIC" && p.status === "ACTIVE");
    const synced: { documents: Record<string, unknown>[] }[] = [];
    server.use(
      http.put(PROJECTS, async ({ request }) => {
        synced.push((await request.json()) as { documents: Record<string, unknown>[] });
        return HttpResponse.json({ indexed: 0, removed: 0 });
      }),
      http.post(`${PROJECTS}/search`, () => HttpResponse.json({ project_ids: [open[0]!.project_id] })),
    );
    const res = await minjun.get("/projects?scope=discover&q=anything");
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { project_id: string }) => i.project_id)).toEqual([open[0]!.project_id]);
    expect(synced[0]!.documents.map((d) => d.project_id).sort()).toEqual(open.map((p) => p.project_id).sort());
    for (const doc of synced[0]!.documents) expect(Object.keys(doc).sort()).toEqual(["lead_organization_id", "lead_organization_name", "member_count", "name", "project_id", "updated_at"]);

    // My projects are not a public search: no call, names are matched here.
    const before = synced.length;
    await minjun.get("/projects?q=anything");
    expect(synced).toHaveLength(before);
  });
});
