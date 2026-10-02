import { beforeEach, describe, expect, it } from "vitest";
import { setMockUser } from "../../tests/render";
import { api, unwrap } from "@/shared/api/client";
import type { AccessGrant, AccessRequest, AuditEvent, Page, ProjectSummary, Schemas } from "@/shared/api/types";
import { getDb, resetDb } from "./db";
import { createSeed, DATASET, GRANT, ORG, PROJECT, REQUEST, USER } from "./fixtures";
import { enrichSeed, PORTAL_DATASET } from "./fixtures-portal";

const DAY = 86_400_000;
const NOW = new Date("2026-10-02T05:00:00Z"); // Friday 14:00 KST

describe("portal-volume mock seed", () => {
  beforeEach(() => resetDb(new Date(), { portal: true }));

  it("keeps every base id and adds 8 datasets across two more institutes", () => {
    const db = getDb();
    const base = createSeed(new Date());
    for (const d of base.datasets) expect(db.datasets.some((x) => x.dataset_id === d.dataset_id)).toBe(true);
    for (const id of [REQUEST.seedApproved]) expect(db.requests.some((r) => r.access_request_id === id)).toBe(true);
    expect(db.grants.find((g) => g.access_grant_id === GRANT.seed)?.status).toBe("ACTIVE");
    expect(db.projects.some((p) => p.project_id === PROJECT.seed)).toBe(true);
    expect(db.datasets).toHaveLength(13);
    expect(new Set(db.datasets.map((d) => d.owner_organization_id)).size).toBe(4);
    expect(new Set([...db.datasets.map((d) => d.dataset_id), ...db.versions.map((v) => v.dataset_version_id), ...db.requests.map((r) => r.access_request_id)]).size).toBe(
      db.datasets.length + db.versions.length + db.requests.length,
    );
  });

  it("is deterministic and never dated in the future", () => {
    const a = enrichSeed(createSeed(NOW), NOW);
    const b = enrichSeed(createSeed(NOW), NOW);
    expect(a.audit.map((e) => [e.action, e.occurred_at])).toEqual(b.audit.map((e) => [e.action, e.occurred_at]));
    expect(a.audit.every((e) => Date.parse(e.occurred_at) <= NOW.getTime())).toBe(true);
    expect(a.versions.every((v) => !v.published_at || Date.parse(v.published_at) <= NOW.getTime())).toBe(true);
  });

  it("spreads 30 days of activity with quieter weekends", () => {
    const events = getDb().audit.filter((e) => Date.now() - Date.parse(e.occurred_at) < 30 * DAY);
    const days = new Set(events.map((e) => new Date(Date.parse(e.occurred_at) + 9 * 3_600_000).toISOString().slice(0, 10)));
    expect(days.size).toBeGreaterThanOrEqual(20);
    const downloads = events.filter((e) => e.action === "FILE_DOWNLOADED");
    expect(downloads.length).toBeGreaterThan(50);
    const kstDay = (e: AuditEvent) => new Date(Date.parse(e.occurred_at) + 9 * 3_600_000).getUTCDay();
    const weekend = downloads.filter((e) => kstDay(e) === 0 || kstDay(e) === 6).length;
    expect(weekend / downloads.length).toBeLessThan(0.15);
  });

  it("serves contract-valid lists with a steward's queue, a researcher's requests and expiring grants", async () => {
    setMockUser(USER.bSteward);
    const review = (await unwrap(api.GET("/access-requests", { params: { query: { role: "reviewer", status: ["SUBMITTED", "UNDER_REVIEW"], limit: 50 } } }))) as Page<AccessRequest>;
    expect(review.items.map((r) => r.dataset_id)).toEqual(expect.arrayContaining([DATASET.battery, PORTAL_DATASET.semLabels]));
    expect(review.items).toHaveLength(4);
    const owned = (await unwrap(api.GET("/access-grants", { params: { query: { role: "owner", status: ["ACTIVE"], limit: 50 } } }))) as Page<AccessGrant>;
    expect(owned.items.filter((g) => Date.parse(g.expires_at) - Date.now() < 7 * DAY).length).toBeGreaterThanOrEqual(1);
    const audit = (await unwrap(api.GET("/audit-events", { params: { query: { limit: 100, from: new Date(Date.now() - 30 * DAY).toISOString() } } }))) as Page<AuditEvent>;
    expect(audit.items.some((e) => e.action === "FILE_DOWNLOADED")).toBe(true);
    const search = (await unwrap(api.GET("/datasets", { params: { query: { owner_organization_id: [ORG.b], limit: 50 } } }))) as Schemas["DatasetSearchResult"];
    expect(search.total).toBe(5);
    expect(new Set((search.facets.readiness_status ?? []).map((b) => b.value))).toEqual(new Set(["PASS", "WARNING", "FAIL"]));

    setMockUser(USER.aResearcher);
    const mine = (await unwrap(api.GET("/access-requests", { params: { query: { role: "requester", limit: 50 } } }))) as Page<AccessRequest>;
    expect(mine.items.map((r) => r.status)).toEqual(expect.arrayContaining(["CHANGE_REQUESTED", "SUBMITTED", "APPROVED"]));
    const grants = (await unwrap(api.GET("/access-grants", { params: { query: { role: "subject", status: ["ACTIVE"], limit: 50 } } }))) as Page<AccessGrant>;
    expect(grants.items.length).toBeGreaterThanOrEqual(3);
    const projects = (await unwrap(api.GET("/projects", { params: { query: { scope: "mine", limit: 50 } } }))) as Page<ProjectSummary>;
    expect(projects.items.length).toBe(3);
  });
});
