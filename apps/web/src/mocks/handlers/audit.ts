import { http, HttpResponse } from "msw";
import type { Schemas } from "@/shared/api/types";
import { getDb } from "../db";
import { API, currentUser, fail, newestFirst, paginate } from "../http";
import { memberOf } from "./projects";

/** Visibility per M09 §6 (listAuditEvents): platform admin all; org admin/steward own-org rows; everyone own rows + member projects. */
export const auditHandlers = [
  http.get(`${API}/audit-events`, ({ request }) => {
    const user = currentUser(request);
    const db = getDb();
    const url = new URL(request.url);
    const actions = url.searchParams.getAll("action");
    const projectId = url.searchParams.get("project_id");
    const actorId = url.searchParams.get("actor_user_id");
    const orgId = url.searchParams.get("organization_id");
    const resourceType = url.searchParams.get("resource_type");
    const resourceId = url.searchParams.get("resource_id");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const isPlatformAdmin = user.platform_roles.includes("PLATFORM_ADMIN");
    const isOrgScoped = user.org_roles.includes("ORG_ADMIN") || user.org_roles.includes("DATA_STEWARD");
    const isProjectMember = !!projectId && !!memberOf(db, projectId, user.user_id);

    if (!isPlatformAdmin) {
      if (orgId && orgId !== user.organization_id) fail("FORBIDDEN", "organization_id is outside your organization.");
      if (projectId && !isProjectMember && !isOrgScoped) fail("FORBIDDEN", "You are not a member of this project.");
    }

    const isDownload = (e: Schemas["AuditEvent"]) => e.action === "FILE_DOWNLOADED" || e.action === "DOWNLOAD_DENIED";
    const inScope = (e: Schemas["AuditEvent"]) => {
      if (isPlatformAdmin) return true;
      if (e.actor.user_id === user.user_id) return true;
      // Staff: owner-org rows, plus actor-org rows except downloads of data owned elsewhere (M09-AT-08).
      if (isOrgScoped) {
        if (e.resource.owner_organization_id === user.organization_id) return true;
        if (e.actor.organization_id === user.organization_id && !isDownload(e)) return true;
      }
      // Project-member scope never includes DOWNLOAD_DENIED.
      return isProjectMember && e.project_id === projectId && e.action !== "DOWNLOAD_DENIED";
    };
    const items = db.audit
      .filter(inScope)
      .filter((e) => !actions.length || actions.includes(e.action))
      .filter((e) => !projectId || e.project_id === projectId)
      .filter((e) => !actorId || e.actor.user_id === actorId)
      .filter((e) => !orgId || e.actor.organization_id === orgId || e.resource.owner_organization_id === orgId)
      .filter((e) => !resourceType || e.resource.type === resourceType)
      .filter((e) => !resourceId || e.resource.id === resourceId)
      .filter((e) => !from || e.occurred_at >= from)
      .filter((e) => !to || e.occurred_at < to)
      .sort(newestFirst("occurred_at"));
    return HttpResponse.json(paginate(items, url));
  }),
];
