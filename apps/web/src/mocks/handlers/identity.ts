import { http, HttpResponse } from "msw";
import { ENUMS } from "@/generated/contracts";
import type { Schemas } from "@/shared/api/types";
import { getDb } from "../db";
import { API, body, currentUser, fail, nowIso, orgName, paginate, recordAudit, validationFailed } from "../http";
import type { MockDb, MockUser } from "../types";

export function meView(db: MockDb, u: MockUser): Schemas["Me"] {
  const org = db.organizations.find((o) => o.organization_id === u.organization_id)!;
  return {
    user_id: u.user_id,
    display_name: u.display_name,
    email: u.email,
    status: u.status,
    organization: { organization_id: org.organization_id, code: org.code, name: org.name, type: org.type },
    org_roles: u.org_roles,
    platform_roles: u.platform_roles,
  };
}

function membershipView(u: MockUser): Schemas["OrganizationMembership"] {
  return { user_id: u.user_id, organization_id: u.organization_id, display_name: u.display_name, email: u.email, roles: u.org_roles, status: u.membership_status, updated_at: u.updated_at };
}

function requireOrgAdmin(user: MockUser, organizationId: string) {
  const ok = user.platform_roles.includes("PLATFORM_ADMIN") || (user.organization_id === organizationId && user.org_roles.includes("ORG_ADMIN"));
  if (!ok) fail("FORBIDDEN");
}

export const identityHandlers = [
  http.get(`${API}/health/live`, () => HttpResponse.json({ status: "ok" })),
  http.get(`${API}/health/ready`, () => HttpResponse.json({ status: "ok", checks: { mock: "ok" } })),

  http.get(`${API}/me`, ({ request }) => HttpResponse.json(meView(getDb(), currentUser(request)))),

  http.get(`${API}/users`, ({ request }) => {
    currentUser(request);
    const db = getDb();
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    if (q && q.length < 2) validationFailed("q", "TOO_SHORT", "q must have at least 2 characters");
    const org = url.searchParams.get("organization_id");
    const items: Schemas["IdentityPublicProfile"][] = db.users
      .filter((u) => u.status === "ACTIVE" && u.membership_status === "ACTIVE")
      .filter((u) => !org || u.organization_id === org)
      .filter((u) => !q || u.display_name.toLowerCase().includes(q) || u.email.toLowerCase().startsWith(q))
      .map((u) => ({ user_id: u.user_id, display_name: u.display_name, organization_id: u.organization_id, organization_name: orgName(db, u.organization_id), status: u.status }));
    return HttpResponse.json(paginate(items, url));
  }),

  http.get(`${API}/organizations`, ({ request }) => {
    currentUser(request);
    const items = getDb().organizations.map(({ organization_id, code, name, type }) => ({ organization_id, code, name, type }));
    return HttpResponse.json(paginate(items, new URL(request.url)));
  }),

  http.get(`${API}/organizations/:organization_id`, ({ request, params }) => {
    currentUser(request);
    const org = getDb().organizations.find((o) => o.organization_id === params.organization_id);
    if (!org) fail("NOT_FOUND");
    return HttpResponse.json(org);
  }),

  http.get(`${API}/organizations/:organization_id/members`, ({ request, params }) => {
    const user = currentUser(request);
    const orgId = String(params.organization_id);
    requireOrgAdmin(user, orgId);
    const items = getDb().users.filter((u) => u.organization_id === orgId).map(membershipView);
    return HttpResponse.json(paginate(items, new URL(request.url)));
  }),

  http.patch(`${API}/organizations/:organization_id/members/:user_id`, async ({ request, params }) => {
    const user = currentUser(request);
    const orgId = String(params.organization_id);
    requireOrgAdmin(user, orgId);
    const db = getDb();
    const target = db.users.find((u) => u.user_id === params.user_id && u.organization_id === orgId);
    if (!target) fail("NOT_FOUND");
    const patch = await body<{ roles?: Schemas["OrgRole"][]; status?: Schemas["ActiveStatus"] }>(request);
    if (patch.roles === undefined && patch.status === undefined) fail("VALIDATION_FAILED", "empty patch");
    if (patch.roles) {
      if (patch.roles.some((r) => !(ENUMS.OrgRole as readonly string[]).includes(r))) fail("ROLE_NOT_ASSIGNABLE");
      target.org_roles = [...new Set(patch.roles)];
      recordAudit(db, { action: "ADMIN_ROLE_CHANGED", actor: user, resource: { type: "MEMBERSHIP", id: target.user_id, owner_organization_id: orgId }, details: { roles: target.org_roles } });
    }
    if (patch.status) {
      target.membership_status = patch.status;
      if (patch.status === "DISABLED") {
        for (const g of db.grants.filter((g) => g.subject_user_id === target.user_id && g.status === "ACTIVE")) {
          g.status = "REVOKED";
          g.revoked_at = nowIso();
          g.revoked_by = null;
          g.revocation_reason = "MEMBERSHIP_DISABLED";
        }
      }
    }
    target.updated_at = nowIso();
    return HttpResponse.json(membershipView(target));
  }),
];
