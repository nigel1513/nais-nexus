import { http, HttpResponse } from "msw";
import type { Schemas } from "@/shared/api/types";
import { getDb } from "../db";
import { API, body, currentUser, fail, newestFirst, newId, notify, nowIso, orgName, paginate, recordAudit } from "../http";
import type { MockDb, MockUser, StoredProject } from "../types";

export function memberOf(db: MockDb, projectId: string, userId: string) {
  return db.projectMembers.find((m) => m.project_id === projectId && m.user_id === userId);
}

export function projectView(db: MockDb, p: StoredProject, userId: string): Schemas["Project"] {
  return {
    ...p,
    my_role: memberOf(db, p.project_id, userId)?.role ?? null,
    member_count: db.projectMembers.filter((m) => m.project_id === p.project_id).length,
  };
}

/** M02 visibility: non-members get 404 for PRIVATE and 403 FORBIDDEN for PUBLIC. */
function visibleProject(db: MockDb, projectId: string, user: MockUser): StoredProject {
  const p = db.projects.find((x) => x.project_id === projectId);
  if (!p) fail("NOT_FOUND");
  if (!memberOf(db, projectId, user.user_id) && !user.platform_roles.includes("PLATFORM_ADMIN")) {
    if (p.visibility === "PRIVATE") fail("NOT_FOUND");
    fail("FORBIDDEN", "Members only");
  }
  return p;
}

function requireManager(db: MockDb, p: StoredProject, user: MockUser) {
  const role = memberOf(db, p.project_id, user.user_id)?.role;
  if (role !== "PROJECT_OWNER" && role !== "PROJECT_ADMIN") fail("FORBIDDEN");
  if (p.status === "ARCHIVED") fail("PROJECT_ARCHIVED");
}

function syncPartnerOrgs(db: MockDb, p: StoredProject) {
  const orgIds = new Set(db.projectMembers.filter((m) => m.project_id === p.project_id).map((m) => m.organization_id));
  orgIds.delete(p.lead_organization_id);
  p.organizations = [
    { organization_id: p.lead_organization_id, name: orgName(db, p.lead_organization_id), role: "LEAD" },
    ...[...orgIds].map((id) => ({ organization_id: id, name: orgName(db, id), role: "PARTNER" as const })),
  ];
}

function revokeProjectGrants(db: MockDb, projectId: string, reason: string, userId?: string) {
  for (const g of db.grants) {
    if (g.project_id === projectId && g.status === "ACTIVE" && (!userId || g.subject_user_id === userId)) {
      g.status = "REVOKED";
      g.revoked_at = nowIso();
      g.revoked_by = null;
      g.revocation_reason = reason;
    }
  }
}

function validateProjectFields(input: Partial<Schemas["ProjectCreate"]>, partial: boolean) {
  const fields: Record<string, string> = {};
  if (!partial || input.name !== undefined) {
    const n = (input.name ?? "").trim();
    if (n.length < 2 || n.length > 200) fields.name = "2-200 characters";
  }
  if (input.description !== undefined && input.description.length > 10000) fields.description = "max 10000";
  if (input.keywords && input.keywords.length > 20) fields.keywords = "max 20";
  if (input.start_date && input.end_date && input.end_date < input.start_date) fields.end_date = "end_date must be on or after start_date";
  if (Object.keys(fields).length) fail("VALIDATION_FAILED", "Invalid project", { fields });
}

export const projectHandlers = [
  http.get(`${API}/projects`, ({ request }) => {
    const user = currentUser(request);
    const db = getDb();
    const url = new URL(request.url);
    const scope = url.searchParams.get("scope") ?? "mine";
    const status = url.searchParams.get("status");
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const items = db.projects
      .filter((p) => (scope === "discover" ? p.visibility === "PUBLIC" && p.status === "ACTIVE" : !!memberOf(db, p.project_id, user.user_id)))
      .filter((p) => !status || p.status === status)
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .map((p) => projectView(db, p, user.user_id))
      .map(({ project_id, name, status: s, visibility, lead_organization_id, my_role, member_count, updated_at }) => ({
        project_id, name, status: s, visibility, lead_organization_id, lead_organization_name: orgName(db, lead_organization_id), my_role, member_count, updated_at,
      }))
      .sort(newestFirst("updated_at"));
    return HttpResponse.json(paginate(items, url));
  }),

  http.post(`${API}/projects`, async ({ request }) => {
    const user = currentUser(request);
    const db = getDb();
    const input = await body<Schemas["ProjectCreate"]>(request);
    validateProjectFields(input, false);
    const now = nowIso();
    const p: StoredProject = {
      project_id: newId(),
      name: input.name.trim(),
      status: "ACTIVE",
      visibility: input.visibility ?? "PRIVATE",
      lead_organization_id: user.organization_id,
      updated_at: now,
      description: input.description ?? "",
      keywords: input.keywords ?? [],
      start_date: input.start_date ?? null,
      end_date: input.end_date ?? null,
      organizations: [{ organization_id: user.organization_id, name: orgName(db, user.organization_id), role: "LEAD" }],
      created_by: user.user_id,
      created_at: now,
      archived_at: null,
    };
    db.projects.push(p);
    db.projectMembers.push({ project_id: p.project_id, user_id: user.user_id, display_name: user.display_name, organization_id: user.organization_id, organization_name: orgName(db, user.organization_id), role: "PROJECT_OWNER", joined_at: now, added_by: user.user_id });
    recordAudit(db, { action: "PROJECT_CREATED", actor: user, resource: { type: "PROJECT", id: p.project_id, owner_organization_id: user.organization_id }, project_id: p.project_id });
    return HttpResponse.json(projectView(db, p, user.user_id), { status: 201 });
  }),

  http.get(`${API}/projects/:project_id`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    return HttpResponse.json(projectView(db, visibleProject(db, String(params.project_id), user), user.user_id));
  }),

  http.patch(`${API}/projects/:project_id`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const p = visibleProject(db, String(params.project_id), user);
    requireManager(db, p, user);
    const patch = await body<Schemas["ProjectUpdate"]>(request);
    if (!Object.keys(patch).length) fail("VALIDATION_FAILED", "empty patch");
    if (patch.visibility !== undefined && memberOf(db, p.project_id, user.user_id)?.role !== "PROJECT_OWNER") fail("FORBIDDEN", "Only the owner changes visibility");
    validateProjectFields({ ...patch, start_date: patch.start_date ?? undefined, end_date: patch.end_date ?? undefined }, true);
    Object.assign(p, patch, { updated_at: nowIso() });
    return HttpResponse.json(projectView(db, p, user.user_id));
  }),

  http.post(`${API}/projects/:project_id/archive`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const p = visibleProject(db, String(params.project_id), user);
    if (memberOf(db, p.project_id, user.user_id)?.role !== "PROJECT_OWNER") fail("FORBIDDEN");
    if (p.status === "ARCHIVED") fail("PROJECT_ARCHIVED");
    p.status = "ARCHIVED";
    p.archived_at = nowIso();
    p.updated_at = p.archived_at;
    revokeProjectGrants(db, p.project_id, "PROJECT_ARCHIVED");
    recordAudit(db, { action: "PROJECT_ARCHIVED", actor: user, resource: { type: "PROJECT", id: p.project_id, owner_organization_id: p.lead_organization_id }, project_id: p.project_id });
    return HttpResponse.json(projectView(db, p, user.user_id));
  }),

  http.get(`${API}/projects/:project_id/members`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const projectId = String(params.project_id);
    if (!db.projects.some((x) => x.project_id === projectId)) fail("NOT_FOUND");
    // M02: members and PLATFORM_ADMIN only; everyone else gets 404 regardless of visibility.
    if (!memberOf(db, projectId, user.user_id) && !user.platform_roles.includes("PLATFORM_ADMIN")) fail("NOT_FOUND");
    return HttpResponse.json({ items: db.projectMembers.filter((m) => m.project_id === projectId) });
  }),

  http.post(`${API}/projects/:project_id/members`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const p = visibleProject(db, String(params.project_id), user);
    requireManager(db, p, user);
    const input = await body<{ user_id: string; role: Schemas["ProjectRole"] }>(request);
    const target = db.users.find((u) => u.user_id === input.user_id && u.status === "ACTIVE" && u.membership_status === "ACTIVE");
    if (!target) fail("VALIDATION_FAILED", "Unknown user", { fields: { user_id: "unknown" } });
    if (memberOf(db, p.project_id, target.user_id)) fail("PROJECT_MEMBER_EXISTS");
    const member: Schemas["ProjectMember"] = {
      project_id: p.project_id,
      user_id: target.user_id,
      display_name: target.display_name,
      organization_id: target.organization_id,
      organization_name: orgName(db, target.organization_id),
      role: input.role,
      joined_at: nowIso(),
      added_by: user.user_id,
    };
    db.projectMembers.push(member);
    syncPartnerOrgs(db, p);
    p.updated_at = nowIso();
    if (target.user_id !== user.user_id) notify(db, [target.user_id], "PROJECT_INVITATION", `"${p.name}" 프로젝트에 참여자로 추가되었습니다`, `/commons/projects/${p.project_id}`);
    recordAudit(db, { action: "PROJECT_MEMBER_ADDED", actor: user, resource: { type: "PROJECT_MEMBER", id: target.user_id, owner_organization_id: p.lead_organization_id }, project_id: p.project_id, details: { role: input.role } });
    return HttpResponse.json(member, { status: 201 });
  }),

  http.patch(`${API}/projects/:project_id/members/:user_id`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const p = visibleProject(db, String(params.project_id), user);
    requireManager(db, p, user);
    const member = memberOf(db, p.project_id, String(params.user_id));
    if (!member) fail("PROJECT_MEMBER_NOT_FOUND");
    const { role } = await body<{ role: Schemas["ProjectRole"] }>(request);
    const owners = db.projectMembers.filter((m) => m.project_id === p.project_id && m.role === "PROJECT_OWNER");
    if (member.role === "PROJECT_OWNER" && role !== "PROJECT_OWNER" && owners.length === 1) fail("PROJECT_LAST_OWNER");
    member.role = role;
    recordAudit(db, { action: "PROJECT_MEMBER_ROLE_CHANGED", actor: user, resource: { type: "PROJECT_MEMBER", id: member.user_id, owner_organization_id: p.lead_organization_id }, project_id: p.project_id, details: { role } });
    return HttpResponse.json(member);
  }),

  http.delete(`${API}/projects/:project_id/members/:user_id`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const p = visibleProject(db, String(params.project_id), user);
    const targetId = String(params.user_id);
    if (targetId !== user.user_id) requireManager(db, p, user);
    const member = memberOf(db, p.project_id, targetId);
    if (!member) fail("PROJECT_MEMBER_NOT_FOUND");
    const owners = db.projectMembers.filter((m) => m.project_id === p.project_id && m.role === "PROJECT_OWNER");
    if (member.role === "PROJECT_OWNER" && owners.length === 1) fail("PROJECT_LAST_OWNER");
    db.projectMembers.splice(db.projectMembers.indexOf(member), 1);
    syncPartnerOrgs(db, p);
    revokeProjectGrants(db, p.project_id, "PROJECT_MEMBER_REMOVED", targetId);
    recordAudit(db, { action: "PROJECT_MEMBER_REMOVED", actor: user, resource: { type: "PROJECT_MEMBER", id: targetId, owner_organization_id: p.lead_organization_id }, project_id: p.project_id });
    return new HttpResponse(null, { status: 204 });
  }),
];
