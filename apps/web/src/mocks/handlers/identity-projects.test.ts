import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkSchema } from "../../../tests/contract";
import { setMockUser } from "../../../tests/render";
import { api, unwrap } from "@/shared/api/client";
import type { AuditEvent, IdentityPublicProfile, NotificationPage, Page, ProjectSummary } from "@/shared/api/types";
import { getDb } from "../db";
import { DATASET, GRANT, ORG, PROJECT, REQUEST, SEED_USERS, USER, VERSION } from "../fixtures";

const as = (user: string | null) => setMockUser(user);

describe("seed fidelity (10_SEED_DATA / seed_ids.json)", () => {
  const ids = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../../../../infra/keycloak/seed_ids.json"), "utf8")) as {
    organizations: Record<string, string>;
    users: Record<string, string>;
  };

  it("organization and user ids equal the Keycloak seed ids", () => {
    expect(ORG.nais).toBe(ids.organizations.nais);
    expect(ORG.a).toBe(ids.organizations["inst-a"]);
    expect(ORG.b).toBe(ids.organizations["inst-b"]);
    const db = getDb();
    expect(Object.fromEntries(db.users.map((u) => [u.email, u.user_id]))).toEqual(ids.users);
    expect(SEED_USERS).toHaveLength(8);
  });

  it("seeds NTIS researcher numbers and empty membership history", () => {
    const byEmail = Object.fromEntries(getDb().users.map((u) => [u.email, u]));
    expect(byEmail["a.researcher@inst-a.local"]?.national_researcher_number).toBe("10000001");
    expect(byEmail["b.steward@inst-b.local"]?.national_researcher_number).toBe("10000004");
    expect(byEmail["admin@nais.local"]?.national_researcher_number).toBeNull();
    expect(getDb().users.every((u) => u.history.length === 0)).toBe(true);
  });

  it("has exactly the seed project and the five seed datasets with real titles", () => {
    const db = getDb();
    expect(db.projects.map((p) => [p.project_id, p.name])).toEqual([[PROJECT.seed, "차세대 이차전지 소재 공동연구"]]);
    expect(PROJECT.seed).toBe("00000000-0000-7000-8000-000000001001");
    expect(db.datasets.map((d) => [d.dataset_id.slice(-4), d.title, d.owner_organization_id === ORG.b ? "b" : "a", d.access_level])).toEqual([
      ["2001", "리튬이온 배터리 셀 사이클 시험 데이터", "b", "CONTROLLED"],
      ["2002", "구조용 세라믹·초내열합금 물성 DB", "b", "PUBLIC"],
      ["2003", "소결 공정 배치별 품질관리 로그", "b", "INTERNAL"],
      ["2004", "시험동 공조 설비 센서 스트림", "a", "SENSITIVE"],
      ["2005", "하이브리드 전해질 후보 스크리닝 (초안)", "a", "CONTROLLED"],
    ]);
    expect(db.versions.map((v) => [v.dataset_version_id.slice(-4), v.status, v.file_count])).toEqual([
      ["2101", "PUBLISHED", 5],
      ["2102", "PUBLISHED", 4],
      ["2103", "PUBLISHED", 4],
      ["2104", "PUBLISHED", 4],
      ["2105", "DRAFT", 0],
      ["2111", "PUBLISHED", 2], // battery history: v1.0, v1.1 and the owner-only draft
      ["2112", "PUBLISHED", 3],
      ["2113", "DRAFT", 5],
    ]);
    expect(VERSION.battery.slice(-4)).toBe("2101");
    expect(DATASET.electrolyte.slice(-4)).toBe("2005");
    expect(REQUEST.seedApproved.slice(-4)).toBe("3001");
    expect(GRANT.seed.slice(-4)).toBe("4001");
  });

  it("every seed object validates against the openapi schemas", () => {
    const db = getDb();
    const bad = [
      ...db.organizations.map((o) => checkSchema("Organization", o)),
      ...db.projects.map((p) => checkSchema("Project", { ...p, my_role: null, member_count: 2 })),
      ...db.projectMembers.map((m) => checkSchema("ProjectMember", m)),
      ...db.datasets.map((d) => checkSchema("Dataset", d)),
      ...db.versions.map((v) => checkSchema("DatasetVersion", v)),
      ...db.uploadSessions.map((u) => checkSchema("UploadSession", u)),
      ...db.requests.map((r) => checkSchema("AccessRequest", r)),
      ...db.grants.map((g) => checkSchema("AccessGrant", g)),
      ...db.validations.map((v) => checkSchema("ReadinessValidation", v)),
      ...db.audit.map((e) => checkSchema("AuditEvent", e)),
    ].flat();
    expect(bad).toEqual([]);
  });

  it("seed grant expires 2 days after seed time and readiness matches the 09 §5.6 golden table", () => {
    const db = getDb();
    const g = db.grants[0]!;
    expect((Date.parse(g.expires_at) - Date.parse(g.valid_from)) / 86_400_000).toBeCloseTo(2, 5);
    const overall = (v: string, p: string) => db.validations.find((x) => x.dataset_version_id === v && x.profile_id === p)?.overall_status;
    expect([VERSION.battery, VERSION.openMaterials, VERSION.qcLogs, VERSION.sensors].map((v) => [overall(v, "GENERIC_BASIC"), overall(v, "TABULAR_ML_BASIC")])).toEqual([
      ["PASS", "PASS"],
      ["FAIL", "FAIL"],
      ["WARNING", "FAIL"],
      ["FAIL", "FAIL"],
    ]);
  });
});

describe("identity mocks", () => {
  it("getMe returns the mock session user with org and roles", async () => {
    as(USER.aSteward);
    const me = await unwrap(api.GET("/me"));
    expect(me).toMatchObject({ display_name: "이서연", org_roles: ["DATA_STEWARD"], organization: { code: "inst-a" } });
  });

  it("no session → 401 UNAUTHENTICATED; disabled membership → 403 MEMBERSHIP_DISABLED", async () => {
    as(null);
    await expect(unwrap(api.GET("/me"))).rejects.toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    as(USER.bDisabled);
    await expect(unwrap(api.GET("/me"))).rejects.toMatchObject({ status: 403, code: "MEMBERSHIP_DISABLED" });
  });

  it("organization members are ORG_ADMIN only", async () => {
    as(USER.aResearcher);
    await expect(unwrap(api.GET("/organizations/{organization_id}/members", { params: { path: { organization_id: ORG.a } } }))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    as(USER.aAdmin);
    const page = await unwrap(api.GET("/organizations/{organization_id}/members", { params: { path: { organization_id: ORG.a } } }));
    expect(page.items).toHaveLength(3);
  });

  it("disabling a membership revokes that user's active grants", async () => {
    as(USER.aAdmin);
    await unwrap(
      api.PATCH("/organizations/{organization_id}/members/{user_id}", {
        params: { path: { organization_id: ORG.a, user_id: USER.aResearcher } },
        body: { status: "DISABLED" },
      }),
    );
    expect(getDb().grants.find((g) => g.access_grant_id === GRANT.seed)?.status).toBe("REVOKED");
  });

  describe("updateOrganizationMember rules (M01 §6)", () => {
    const patch = (organizationId: string, userId: string, body: { roles?: ("ORG_ADMIN" | "DATA_STEWARD" | "RESOURCE_MANAGER")[]; status?: "ACTIVE" | "DISABLED" }) =>
      unwrap(api.PATCH("/organizations/{organization_id}/members/{user_id}", { params: { path: { organization_id: organizationId, user_id: userId } }, body }));
    const adminAudits = () => getDb().audit.filter((e) => e.action === "ADMIN_ROLE_CHANGED").length;

    it("an ORG_ADMIN cannot remove their own ORG_ADMIN role or disable themselves (422 ROLE_NOT_ASSIGNABLE)", async () => {
      as(USER.aAdmin);
      await expect(patch(ORG.a, USER.aAdmin, { roles: [] })).rejects.toMatchObject({ status: 422, code: "ROLE_NOT_ASSIGNABLE" });
      await expect(patch(ORG.a, USER.aAdmin, { status: "DISABLED" })).rejects.toMatchObject({ status: 422, code: "ROLE_NOT_ASSIGNABLE" });
      expect(getDb().users.find((u) => u.user_id === USER.aAdmin)).toMatchObject({ org_roles: ["ORG_ADMIN"], membership_status: "ACTIVE" });
    });

    it("PLATFORM_ADMIN and duplicate roles are rejected before anything changes", async () => {
      as(USER.aAdmin);
      const before = adminAudits();
      await expect(patch(ORG.a, USER.aResearcher, { roles: ["PLATFORM_ADMIN" as never] })).rejects.toMatchObject({ status: 422, code: "ROLE_NOT_ASSIGNABLE" });
      await expect(patch(ORG.a, USER.aResearcher, { roles: ["DATA_STEWARD", "DATA_STEWARD"] })).rejects.toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
      expect(adminAudits()).toBe(before);
    });

    it("a change that changes nothing is a 200 without an audit event; a real change is audited", async () => {
      as(USER.aAdmin);
      const before = adminAudits();
      await patch(ORG.a, USER.aResearcher, { roles: [], status: "ACTIVE" });
      expect(adminAudits()).toBe(before);
      await patch(ORG.a, USER.aResearcher, { roles: ["DATA_STEWARD"] });
      expect(adminAudits()).toBe(before + 1);
    });

    it("PLATFORM_ADMIN may remove the last ORG_ADMIN, including their own role", async () => {
      as(USER.admin);
      const updated = await patch(ORG.nais, USER.admin, { roles: [] });
      expect(updated).toMatchObject({ roles: [] });
    });

    it("nobody can disable their own membership, PLATFORM_ADMIN included (422)", async () => {
      as(USER.admin);
      await expect(patch(ORG.nais, USER.admin, { status: "DISABLED" })).rejects.toMatchObject({ status: 422, code: "ROLE_NOT_ASSIGNABLE" });
      expect(getDb().users.find((u) => u.user_id === USER.admin)?.membership_status).toBe("ACTIVE");
    });

    it("another organization's admin gets 403", async () => {
      as(USER.aAdmin);
      await expect(patch(ORG.b, USER.bResearcher, { roles: ["DATA_STEWARD"] })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    });
  });

  it("listUsers matches display name or email prefix", async () => {
    as(USER.aResearcher);
    const page = (await unwrap(api.GET("/users", { params: { query: { q: "b.re" } } }))) as Page<IdentityPublicProfile>;
    expect(page.items.map((u) => u.display_name)).toEqual(["최유진"]);
  });
});

describe("project mocks", () => {
  const create = (name: string, visibility?: "PUBLIC") => unwrap(api.POST("/projects", { body: { name, description: "", ...(visibility ? { visibility } : {}) } }));

  it("lists only my projects with my_role and member_count; discover lists ACTIVE PUBLIC ones with null role", async () => {
    as(USER.bResearcher);
    const pub = await create("Open Benchmark", "PUBLIC");
    as(USER.aResearcher);
    const mine = (await unwrap(api.GET("/projects", { params: { query: { scope: "mine" } } }))) as Page<ProjectSummary>;
    expect(mine.items).toEqual([expect.objectContaining({ project_id: PROJECT.seed, my_role: "PROJECT_OWNER", member_count: 2 })]);
    as(USER.aSteward);
    const none = (await unwrap(api.GET("/projects"))) as Page<ProjectSummary>;
    expect(none.items).toEqual([]);
    const discover = (await unwrap(api.GET("/projects", { params: { query: { scope: "discover" } } }))) as Page<ProjectSummary>;
    expect(discover.items).toEqual([expect.objectContaining({ project_id: pub.project_id, my_role: null })]);
  });

  it("non-members get 404 for PRIVATE and 403 for PUBLIC; member list is 404 for any non-member", async () => {
    as(USER.aSteward);
    await expect(unwrap(api.GET("/projects/{project_id}", { params: { path: { project_id: PROJECT.seed } } }))).rejects.toMatchObject({ status: 404 });
    as(USER.bResearcher);
    const pub = await create("Open Benchmark", "PUBLIC");
    as(USER.aResearcher);
    await expect(unwrap(api.GET("/projects/{project_id}", { params: { path: { project_id: pub.project_id } } }))).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(unwrap(api.GET("/projects/{project_id}/members", { params: { path: { project_id: pub.project_id } } }))).rejects.toMatchObject({ status: 404 });
  });

  it("creates a project with the caller as owner and validates end >= start", async () => {
    as(USER.aResearcher);
    await expect(unwrap(api.POST("/projects", { body: { name: "X", description: "" } }))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { fields: [{ field: "name", reason: "LENGTH_2_200" }] },
    });
    await expect(
      unwrap(api.POST("/projects", { body: { name: "Bad dates", description: "", start_date: "2026-10-02", end_date: "2026-10-01" } })),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const created = await create("E2E Joint Study");
    expect(created).toMatchObject({ my_role: "PROJECT_OWNER", visibility: "PRIVATE", lead_organization_id: ORG.a, member_count: 1 });
  });

  it("adds members once, notifies them, and protects the last owner", async () => {
    as(USER.aResearcher);
    const path = { project_id: PROJECT.seed };
    await expect(unwrap(api.POST("/projects/{project_id}/members", { params: { path }, body: { user_id: USER.bResearcher, role: "RESEARCHER" } }))).rejects.toMatchObject({
      code: "PROJECT_MEMBER_EXISTS",
    });
    await unwrap(api.POST("/projects/{project_id}/members", { params: { path }, body: { user_id: USER.bSteward, role: "VIEWER" } }));
    expect(getDb().notifications.some((n) => n.user_id === USER.bSteward && n.type === "PROJECT_INVITATION")).toBe(true);
    await expect(
      unwrap(api.PATCH("/projects/{project_id}/members/{user_id}", { params: { path: { ...path, user_id: USER.aResearcher } }, body: { role: "RESEARCHER" } })),
    ).rejects.toMatchObject({ code: "PROJECT_LAST_OWNER" });
  });

  it("only the owner changes visibility", async () => {
    as(USER.aResearcher);
    const path = { project_id: PROJECT.seed };
    await unwrap(api.POST("/projects/{project_id}/members", { params: { path }, body: { user_id: USER.aSteward, role: "PROJECT_ADMIN" } }));
    as(USER.aSteward);
    await expect(unwrap(api.PATCH("/projects/{project_id}", { params: { path }, body: { visibility: "PUBLIC" } }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await unwrap(api.PATCH("/projects/{project_id}", { params: { path }, body: { name: "Renamed study" } }));
  });

  it("PROJECT_ADMIN follows can_manage_member (roles.py)", async () => {
    as(USER.aResearcher);
    const path = { project_id: PROJECT.seed };
    const add = (user_id: string, role: "PROJECT_OWNER" | "PROJECT_ADMIN" | "RESEARCHER" | "VIEWER") =>
      unwrap(api.POST("/projects/{project_id}/members", { params: { path }, body: { user_id, role } }));
    await add(USER.aSteward, "PROJECT_ADMIN");
    await add(USER.aAdmin, "PROJECT_ADMIN");
    as(USER.aSteward);
    await expect(add(USER.bSteward, "PROJECT_OWNER")).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(
      unwrap(api.PATCH("/projects/{project_id}/members/{user_id}", { params: { path: { ...path, user_id: USER.aAdmin } }, body: { role: "VIEWER" } })),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      unwrap(api.PATCH("/projects/{project_id}/members/{user_id}", { params: { path: { ...path, user_id: USER.bResearcher } }, body: { role: "PROJECT_ADMIN" } })),
    ).rejects.toMatchObject({ status: 403 });
    await expect(unwrap(api.DELETE("/projects/{project_id}/members/{user_id}", { params: { path: { ...path, user_id: USER.aResearcher } } }))).rejects.toMatchObject({ status: 403 });
    // RESEARCHER/VIEWER are manageable by an admin
    await add(USER.bSteward, "VIEWER");
    await unwrap(api.PATCH("/projects/{project_id}/members/{user_id}", { params: { path: { ...path, user_id: USER.bSteward } }, body: { role: "RESEARCHER" } }));
    await unwrap(api.DELETE("/projects/{project_id}/members/{user_id}", { params: { path: { ...path, user_id: USER.bSteward } } }));
    // self-leave of an admin stays allowed
    await unwrap(api.DELETE("/projects/{project_id}/members/{user_id}", { params: { path: { ...path, user_id: USER.aSteward } } }));
  });

  it("PATCH project: owner-only only when visibility changes; dates validated against stored values", async () => {
    as(USER.aResearcher);
    const path = { project_id: PROJECT.seed };
    await unwrap(api.POST("/projects/{project_id}/members", { params: { path }, body: { user_id: USER.aSteward, role: "PROJECT_ADMIN" } }));
    await unwrap(api.PATCH("/projects/{project_id}", { params: { path }, body: { start_date: "2026-09-01" } }));
    as(USER.aSteward);
    await unwrap(api.PATCH("/projects/{project_id}", { params: { path }, body: { visibility: "PRIVATE", name: "Same visibility" } }));
    await expect(unwrap(api.PATCH("/projects/{project_id}", { params: { path }, body: { end_date: "2026-08-31" } }))).rejects.toMatchObject({
      status: 422,
      code: "VALIDATION_FAILED",
      details: { fields: [{ field: "end_date", reason: "END_BEFORE_START" }] },
    });
  });

  it("pagination rejects an invalid cursor or limit with 422", async () => {
    as(USER.aResearcher);
    await expect(unwrap(api.GET("/projects", { params: { query: { cursor: "abc" } } }))).rejects.toMatchObject({
      status: 422,
      details: { fields: [{ field: "cursor", reason: "INVALID_CURSOR" }] },
    });
    await expect(unwrap(api.GET("/projects", { params: { query: { limit: 0 } } }))).rejects.toMatchObject({ status: 422 });
    await expect(unwrap(api.GET("/projects", { params: { query: { limit: 101 } } }))).rejects.toMatchObject({ status: 422 });
  });

  it("archive and role-change audit rows carry no owner organization (M09 §7.1)", async () => {
    as(USER.aResearcher);
    const path = { project_id: PROJECT.seed };
    await unwrap(api.PATCH("/projects/{project_id}/members/{user_id}", { params: { path: { ...path, user_id: USER.bResearcher } }, body: { role: "VIEWER" } }));
    await unwrap(api.POST("/projects/{project_id}/archive", { params: { path } }));
    const rows = getDb().audit.filter((e) => e.action === "PROJECT_ARCHIVED" || e.action === "PROJECT_MEMBER_ROLE_CHANGED");
    expect(rows).toHaveLength(2);
    expect(rows.every((e) => e.resource.owner_organization_id === null)).toBe(true);
  });

  it("archiving revokes project-scoped grants and blocks further changes", async () => {
    as(USER.aResearcher);
    const path = { project_id: PROJECT.seed };
    await unwrap(api.POST("/projects/{project_id}/archive", { params: { path } }));
    expect(getDb().grants.find((g) => g.access_grant_id === GRANT.seed)?.status).toBe("REVOKED");
    await expect(unwrap(api.PATCH("/projects/{project_id}", { params: { path }, body: { name: "New name" } }))).rejects.toMatchObject({ code: "PROJECT_ARCHIVED" });
  });
});

describe("audit and notification mocks", () => {
  it("regular users see only their own audit events", async () => {
    as(USER.aResearcher);
    const page = (await unwrap(api.GET("/audit-events"))) as Page<AuditEvent>;
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((e) => e.actor.user_id === USER.aResearcher)).toBe(true);
    as(USER.bSteward);
    const steward = (await unwrap(api.GET("/audit-events"))) as Page<AuditEvent>;
    expect(steward.items.some((e) => e.actor.user_id !== USER.bSteward && e.resource.owner_organization_id === ORG.b)).toBe(true);
    expect(steward.items.every((e) => e.actor.organization_id === ORG.b || e.resource.owner_organization_id === ORG.b)).toBe(true);
  });

  it("project filter: members see the project's rows, non-members get 403, other orgs get 403", async () => {
    as(USER.bResearcher);
    const seeded = (await unwrap(api.GET("/audit-events", { params: { query: { project_id: PROJECT.seed } } }))) as Page<AuditEvent>;
    expect(seeded.items.length).toBeGreaterThan(0);
    expect(seeded.items.every((e) => e.project_id === PROJECT.seed)).toBe(true);
    as(USER.aSteward);
    // stewards are org-scoped, so a project they do not belong to just narrows; ordinary users are refused.
    as(USER.aResearcher);
    await expect(unwrap(api.GET("/audit-events", { params: { query: { organization_id: ORG.b } } }))).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    as(USER.bAdmin);
    await unwrap(api.GET("/audit-events", { params: { query: { project_id: PROJECT.seed } } }));
  });

  it("DOWNLOAD_DENIED is hidden from project-member scope but visible to the owner org and the actor", async () => {
    const db = getDb();
    db.audit.push({
      audit_event_id: crypto.randomUUID(),
      occurred_at: new Date().toISOString(),
      action: "DOWNLOAD_DENIED",
      result: "DENIED",
      reason: "ACCESS_GRANT_NOT_FOUND",
      actor: { type: "USER", user_id: USER.aResearcher, display_name: "김민준", organization_id: ORG.a },
      resource: { type: "DATASET_VERSION", id: VERSION.battery, owner_organization_id: ORG.b },
      project_id: PROJECT.seed,
      policy_version: null,
      source_event_id: crypto.randomUUID(),
      source_event_type: "governance.download.denied.v1",
      trace_id: "t",
      details: {},
    });
    const has = async () => ((await unwrap(api.GET("/audit-events", { params: { query: { project_id: PROJECT.seed } } }))) as Page<AuditEvent>).items.some((e) => e.action === "DOWNLOAD_DENIED");
    as(USER.bResearcher);
    expect(await has()).toBe(false);
    as(USER.aResearcher);
    expect(await has()).toBe(true);
    as(USER.bSteward);
    expect(await has()).toBe(true);
    as(USER.aSteward);
    expect(await has()).toBe(false);
    as(USER.admin);
    expect(await has()).toBe(true);
  });

  it("counts unread notifications and marks all read", async () => {
    as(USER.aResearcher);
    const before = (await unwrap(api.GET("/notifications", { params: { query: { unread_only: true } } }))) as NotificationPage;
    expect(before.unread_count).toBe(1);
    expect(before.items[0]).toMatchObject({ type: "ACCESS_EXPIRING", link: "/commons/access?tab=grants" });
    await unwrap(api.POST("/notifications/read-all"));
    const after = (await unwrap(api.GET("/notifications"))) as NotificationPage;
    expect(after.unread_count).toBe(0);
  });

  it("injects errors on demand", async () => {
    as(USER.aResearcher);
    window.history.replaceState({}, "", "/commons?mock_error=POLICY_ENGINE_UNAVAILABLE");
    await expect(unwrap(api.GET("/me"))).rejects.toMatchObject({ status: 503, code: "POLICY_ENGINE_UNAVAILABLE" });
  });
});
