import { http, HttpResponse } from "msw";
import type { Schemas } from "@/shared/api/types";
import { getDb } from "../db";
import { API, body, currentUser, fail, newestFirst, newId, notify, nowIso, paginate, publicOrigin, recordAudit, validationFailed } from "../http";
import type { MockDb, MockUser } from "../types";
import { bucketOf, canSeeDataset, isOwnerSteward, visibleVersion } from "./catalog";
import { memberOf } from "./projects";

type Req = Schemas["AccessRequest"];
type Grant = Schemas["AccessGrant"];
const OPEN: Req["status"][] = ["SUBMITTED", "UNDER_REVIEW", "CHANGE_REQUESTED"];
const POLICY_VERSION = "data_access@1.0.0";

function effective(g: Grant): Grant {
  return g.status === "ACTIVE" && Date.parse(g.expires_at) <= Date.now() ? { ...g, status: "EXPIRED" } : g;
}

function canSee(user: MockUser, r: Req) {
  if (r.requester_user_id === user.user_id) return true;
  return r.owner_organization_id === user.organization_id && (user.org_roles.includes("DATA_STEWARD") || user.org_roles.includes("ORG_ADMIN"));
}

function findRequest(db: MockDb, id: string, user: MockUser): Req {
  const r = db.requests.find((x) => x.access_request_id === id);
  if (!r || !canSee(user, r)) fail("NOT_FOUND");
  return r;
}

function requireReviewer(user: MockUser, r: Req) {
  if (!isOwnerSteward(user, r.owner_organization_id) || r.requester_user_id === user.user_id) fail("ACCESS_NOT_REVIEWER");
}

function transition(r: Req, status: Req["status"], by: MockUser, comment: string | null = null) {
  r.status = status;
  r.updated_at = nowIso();
  r.history = [...(r.history ?? []), { status, at: r.updated_at, by_user_id: by.user_id, comment }];
}

function stewardsOf(db: MockDb, orgId: string) {
  return db.users.filter((u) => u.organization_id === orgId && u.org_roles.includes("DATA_STEWARD")).map((u) => u.user_id);
}

/** M04 §6.1 rules in order (also re-applied by resubmit). */
function checkRequestFields(
  db: MockDb,
  user: MockUser,
  f: { dataset_id: string; project_id: string; purpose: Schemas["Purpose"]; purpose_detail: string; operations: Schemas["Operation"][]; requested_days: number },
) {
  const ds = db.datasets.find((d) => d.dataset_id === f.dataset_id);
  if (!ds || ds.status === "WITHDRAWN" || !canSeeDataset(user, ds, db)) fail("NOT_FOUND");
  const project = db.projects.find((p) => p.project_id === f.project_id);
  const member = project && memberOf(db, f.project_id, user.user_id);
  if (!project || !member) fail("ACCESS_NOT_PROJECT_MEMBER");
  if (project.status === "ARCHIVED") fail("PROJECT_ARCHIVED");
  if (member.role === "VIEWER") fail("FORBIDDEN");
  const ownOrg = ds.owner_organization_id === user.organization_id;
  if (ds.access_level === "PUBLIC" || (ownOrg && (ds.access_level === "INTERNAL" || user.org_roles.includes("DATA_STEWARD") || user.org_roles.includes("ORG_ADMIN")))) fail("ACCESS_NOT_REQUIRED");
  const detail = (f.purpose_detail ?? "").trim();
  if (detail.length < 20 || detail.length > 4000) validationFailed("purpose_detail", "LENGTH");
  if (!ds.policy.allowed_purposes.includes(f.purpose)) fail("ACCESS_PURPOSE_NOT_ALLOWED");
  if (!f.operations?.length || f.operations.some((o) => o !== "READ")) fail("ACCESS_OPERATION_NOT_ALLOWED");
  if (!Number.isInteger(f.requested_days) || f.requested_days < 1) validationFailed("requested_days", "OUT_OF_RANGE");
  if (f.requested_days > ds.policy.max_grant_days || (ds.access_level === "SENSITIVE" && f.requested_days > 30)) fail("ACCESS_DURATION_EXCEEDED");
  return ds;
}

export const governanceHandlers = [
  http.get(`${API}/access-requests`, ({ request }) => {
    const user = currentUser(request);
    const db = getDb();
    const url = new URL(request.url);
    const role = url.searchParams.get("role") ?? "requester";
    const statuses = url.searchParams.getAll("status");
    const projectId = url.searchParams.get("project_id");
    const datasetId = url.searchParams.get("dataset_id");
    if (role === "reviewer" && !user.org_roles.includes("DATA_STEWARD")) fail("FORBIDDEN", "Only a DATA_STEWARD can list requests to review.");
    const submittedAt = (r: Req) => [...(r.history ?? [])].reverse().find((h) => h.status === "SUBMITTED")?.at ?? r.created_at;
    const items = db.requests
      .filter((r) => (role === "reviewer" ? isOwnerSteward(user, r.owner_organization_id) && r.requester_user_id !== user.user_id : r.requester_user_id === user.user_id))
      .filter((r) => !statuses.length || statuses.includes(r.status))
      .filter((r) => !projectId || r.project_id === projectId)
      .filter((r) => !datasetId || r.dataset_id === datasetId)
      .sort((a, b) => submittedAt(b).localeCompare(submittedAt(a)));
    return HttpResponse.json(paginate(items, url));
  }),

  http.post(`${API}/access-requests`, async ({ request }) => {
    const user = currentUser(request);
    const db = getDb();
    const input = await body<Schemas["AccessRequestCreate"]>(request);
    const ds = checkRequestFields(db, user, input);
    const dup = db.requests.find(
      (r) => r.requester_user_id === user.user_id && r.dataset_id === input.dataset_id && r.project_id === input.project_id && OPEN.includes(r.status),
    );
    const activeGrant = db.grants.map(effective).find(
      (g) => g.subject_user_id === user.user_id && g.dataset_id === input.dataset_id && g.project_id === input.project_id && g.status === "ACTIVE",
    );
    if (dup || activeGrant) fail("ACCESS_REQUEST_DUPLICATE", "Open request or active grant exists", { access_request_id: dup?.access_request_id ?? activeGrant?.access_request_id });
    const now = nowIso();
    const r: Req = {
      access_request_id: newId(),
      dataset_id: ds.dataset_id,
      dataset_title: ds.title,
      project_id: input.project_id,
      project_name: db.projects.find((p) => p.project_id === input.project_id)?.name,
      requester_user_id: user.user_id,
      requester_display_name: user.display_name,
      requester_organization_id: user.organization_id,
      owner_organization_id: ds.owner_organization_id,
      purpose: input.purpose,
      purpose_detail: input.purpose_detail.trim(),
      operations: input.operations,
      requested_days: input.requested_days,
      status: "SUBMITTED",
      history: [{ status: "SUBMITTED", at: now, by_user_id: user.user_id, comment: null }],
      access_grant_id: null,
      created_at: now,
      updated_at: now,
    };
    db.requests.push(r);
    notify(db, stewardsOf(db, ds.owner_organization_id), "ACCESS_SUBMITTED", `${ds.title}에 새 접근 요청이 있습니다`, `/commons/access/${r.access_request_id}`);
    recordAudit(db, { action: "ACCESS_REQUESTED", actor: user, resource: { type: "ACCESS_REQUEST", id: r.access_request_id, owner_organization_id: ds.owner_organization_id }, project_id: r.project_id, policy_version: POLICY_VERSION });
    return HttpResponse.json(r, { status: 201 });
  }),

  http.get(`${API}/access-requests/:access_request_id`, ({ request, params }) => {
    const user = currentUser(request);
    return HttpResponse.json(findRequest(getDb(), String(params.access_request_id), user));
  }),

  http.post(`${API}/access-requests/:access_request_id/start-review`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const r = findRequest(db, String(params.access_request_id), user);
    requireReviewer(user, r);
    if (r.status === "SUBMITTED") {
      transition(r, "UNDER_REVIEW", user);
      recordAudit(db, { action: "ACCESS_REVIEW_STARTED", actor: user, resource: { type: "ACCESS_REQUEST", id: r.access_request_id, owner_organization_id: r.owner_organization_id }, project_id: r.project_id });
    } else if (r.status === "UNDER_REVIEW") {
      // Idempotent only for the reviewer who started the review.
      const starter = [...(r.history ?? [])].reverse().find((h) => h.status === "UNDER_REVIEW")?.by_user_id;
      if (starter !== user.user_id) fail("ACCESS_REQUEST_INVALID_STATE");
    } else fail("ACCESS_REQUEST_INVALID_STATE");
    return HttpResponse.json(r);
  }),

  http.post(`${API}/access-requests/:access_request_id/approve`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const r = findRequest(db, String(params.access_request_id), user);
    requireReviewer(user, r);
    if (r.status !== "SUBMITTED" && r.status !== "UNDER_REVIEW") fail("ACCESS_REQUEST_INVALID_STATE");
    const input = await body<Schemas["AccessApprove"]>(request);
    // M04 §6.4: re-check against the CURRENT policy, then the requester's project membership.
    const ds = db.datasets.find((d) => d.dataset_id === r.dataset_id);
    if (!ds || ds.status === "WITHDRAWN") fail("ACCESS_REQUEST_INVALID_STATE");
    if (!ds.policy.allowed_purposes.includes(r.purpose)) fail("ACCESS_PURPOSE_NOT_ALLOWED");
    if (!Number.isInteger(input.grant_days) || input.grant_days < 1) validationFailed("grant_days", "OUT_OF_RANGE");
    if (input.grant_days > r.requested_days || input.grant_days > ds.policy.max_grant_days || (ds.access_level === "SENSITIVE" && input.grant_days > 30)) fail("ACCESS_DURATION_EXCEEDED");
    const operations = input.operations ?? r.operations;
    if (operations.some((o) => !r.operations.includes(o) || o !== "READ")) fail("ACCESS_OPERATION_NOT_ALLOWED");
    if (!memberOf(db, r.project_id, r.requester_user_id)) fail("ACCESS_NOT_PROJECT_MEMBER");
    if (db.projects.find((p) => p.project_id === r.project_id)?.status === "ARCHIVED") fail("PROJECT_ARCHIVED");
    transition(r, "APPROVED", user, input.note ?? null);
    const now = Date.now();
    const grant: Grant = {
      access_grant_id: newId(),
      access_request_id: r.access_request_id,
      subject_type: "USER",
      subject_user_id: r.requester_user_id,
      project_id: r.project_id,
      dataset_id: r.dataset_id,
      dataset_title: r.dataset_title,
      subject_display_name: r.requester_display_name,
      project_name: r.project_name,
      purpose: r.purpose,
      operations,
      valid_from: new Date(now).toISOString(),
      expires_at: new Date(now + input.grant_days * 86_400_000).toISOString(),
      granted_by: user.user_id,
      policy_version: POLICY_VERSION,
      status: "ACTIVE",
      revoked_at: null,
      revoked_by: null,
      revocation_reason: null,
    };
    db.grants.push(grant);
    r.access_grant_id = grant.access_grant_id;
    notify(db, [r.requester_user_id], "ACCESS_APPROVED", `${r.dataset_title} 접근 요청이 승인되었습니다`, `/commons/access/${r.access_request_id}`);
    recordAudit(db, { action: "ACCESS_APPROVED", actor: user, resource: { type: "ACCESS_REQUEST", id: r.access_request_id, owner_organization_id: r.owner_organization_id }, project_id: r.project_id, policy_version: POLICY_VERSION });
    return HttpResponse.json({ access_request: r, access_grant: grant });
  }),

  http.post(`${API}/access-requests/:access_request_id/reject`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const r = findRequest(db, String(params.access_request_id), user);
    requireReviewer(user, r);
    if (r.status !== "SUBMITTED" && r.status !== "UNDER_REVIEW") fail("ACCESS_REQUEST_INVALID_STATE");
    const { reason } = await body<{ reason: string }>(request);
    if (!reason?.trim() || reason.length > 2000) validationFailed("reason", "LENGTH");
    transition(r, "REJECTED", user, reason);
    notify(db, [r.requester_user_id], "ACCESS_REJECTED", `${r.dataset_title} 접근 요청이 거절되었습니다`, `/commons/access/${r.access_request_id}`);
    recordAudit(db, { action: "ACCESS_REJECTED", actor: user, resource: { type: "ACCESS_REQUEST", id: r.access_request_id, owner_organization_id: r.owner_organization_id }, project_id: r.project_id, reason });
    return HttpResponse.json({ access_request: r, access_grant: null });
  }),

  http.post(`${API}/access-requests/:access_request_id/request-changes`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const r = findRequest(db, String(params.access_request_id), user);
    requireReviewer(user, r);
    if (r.status !== "SUBMITTED" && r.status !== "UNDER_REVIEW") fail("ACCESS_REQUEST_INVALID_STATE");
    const { comment } = await body<{ comment: string }>(request);
    if (!comment?.trim() || comment.length > 2000) validationFailed("comment", "LENGTH");
    transition(r, "CHANGE_REQUESTED", user, comment);
    notify(db, [r.requester_user_id], "ACCESS_CHANGES_REQUESTED", `${r.dataset_title} 접근 요청에 수정이 요청되었습니다`, `/commons/access/${r.access_request_id}`);
    // Like the backend (audit/mapping.py reason_key="comment"), the comment is the audit reason.
    recordAudit(db, { action: "ACCESS_CHANGES_REQUESTED", actor: user, resource: { type: "ACCESS_REQUEST", id: r.access_request_id, owner_organization_id: r.owner_organization_id }, project_id: r.project_id, reason: comment });
    return HttpResponse.json({ access_request: r, access_grant: null });
  }),

  http.post(`${API}/access-requests/:access_request_id/resubmit`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const r = findRequest(db, String(params.access_request_id), user);
    if (r.requester_user_id !== user.user_id) fail("FORBIDDEN");
    if (r.status !== "CHANGE_REQUESTED") fail("ACCESS_REQUEST_INVALID_STATE");
    const patch = await body<Partial<Schemas["AccessRequestCreate"]>>(request);
    const next = {
      dataset_id: r.dataset_id,
      project_id: r.project_id,
      purpose: patch.purpose ?? r.purpose,
      purpose_detail: patch.purpose_detail ?? r.purpose_detail,
      operations: patch.operations ?? r.operations,
      requested_days: patch.requested_days ?? r.requested_days,
    };
    checkRequestFields(db, user, next);
    Object.assign(r, { purpose: next.purpose, purpose_detail: next.purpose_detail.trim(), operations: next.operations, requested_days: next.requested_days });
    transition(r, "SUBMITTED", user);
    notify(db, stewardsOf(db, r.owner_organization_id), "ACCESS_SUBMITTED", `${r.dataset_title} 접근 요청이 다시 제출되었습니다`, `/commons/access/${r.access_request_id}`);
    recordAudit(db, { action: "ACCESS_REQUESTED", actor: user, resource: { type: "ACCESS_REQUEST", id: r.access_request_id, owner_organization_id: r.owner_organization_id }, project_id: r.project_id, details: { resubmitted: true } });
    return HttpResponse.json(r);
  }),

  http.post(`${API}/access-requests/:access_request_id/withdraw`, ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const r = findRequest(db, String(params.access_request_id), user);
    if (r.requester_user_id !== user.user_id) fail("FORBIDDEN");
    if (!OPEN.includes(r.status)) fail("ACCESS_REQUEST_INVALID_STATE");
    transition(r, "WITHDRAWN", user);
    recordAudit(db, { action: "ACCESS_WITHDRAWN", actor: user, resource: { type: "ACCESS_REQUEST", id: r.access_request_id, owner_organization_id: r.owner_organization_id }, project_id: r.project_id });
    return HttpResponse.json(r);
  }),

  http.get(`${API}/access-grants`, ({ request }) => {
    const user = currentUser(request);
    const db = getDb();
    const url = new URL(request.url);
    const role = url.searchParams.get("role") ?? "subject";
    if (role === "owner" && !user.org_roles.includes("DATA_STEWARD") && !user.org_roles.includes("ORG_ADMIN")) fail("FORBIDDEN");
    const statuses = url.searchParams.getAll("status");
    const projectId = url.searchParams.get("project_id");
    const datasetId = url.searchParams.get("dataset_id");
    const ownerOf = (g: Grant) => db.datasets.find((d) => d.dataset_id === g.dataset_id)?.owner_organization_id;
    const items = db.grants
      .map(effective)
      .filter((g) => (role === "owner" ? ownerOf(g) === user.organization_id : g.subject_user_id === user.user_id))
      .filter((g) => !statuses.length || statuses.includes(g.status))
      .filter((g) => !projectId || g.project_id === projectId)
      .filter((g) => !datasetId || g.dataset_id === datasetId)
      .sort(newestFirst("valid_from"));
    return HttpResponse.json(paginate(items, url));
  }),

  http.post(`${API}/access-grants/:access_grant_id/revoke`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const g = db.grants.find((x) => x.access_grant_id === params.access_grant_id);
    const ds = g && db.datasets.find((d) => d.dataset_id === g.dataset_id);
    const ownerOrg = !!ds && ds.owner_organization_id === user.organization_id;
    if (!g || !ds || !(ownerOrg || g.subject_user_id === user.user_id)) fail("NOT_FOUND");
    if (!ownerOrg || !(user.org_roles.includes("DATA_STEWARD") || user.org_roles.includes("ORG_ADMIN"))) fail("FORBIDDEN");
    if (effective(g).status !== "ACTIVE") fail("ACCESS_GRANT_NOT_ACTIVE");
    const { reason } = await body<{ reason: string }>(request);
    if (!reason?.trim() || reason.length > 2000) validationFailed("reason", "LENGTH");
    Object.assign(g, { status: "REVOKED", revoked_at: nowIso(), revoked_by: user.user_id, revocation_reason: reason });
    notify(db, [g.subject_user_id], "ACCESS_REVOKED", `${g.dataset_title} 접근 권한이 회수되었습니다`, "/commons/access?tab=grants", reason);
    recordAudit(db, { action: "ACCESS_REVOKED", actor: user, resource: { type: "ACCESS_GRANT", id: g.access_grant_id, owner_organization_id: ds.owner_organization_id }, project_id: g.project_id, reason, policy_version: POLICY_VERSION });
    return HttpResponse.json(g);
  }),

  http.post(`${API}/dataset-versions/:version_id/download-session`, async ({ request, params }) => {
    const user = currentUser(request);
    const db = getDb();
    const input = await body<Schemas["DownloadSessionCreate"]>(request);
    const projectId = input.project_id ?? null;
    const versionId = String(params.version_id);
    // D-017: every refusal, from step 1 on, is audited as DOWNLOAD_DENIED before the error is returned.
    const audit = (code: string, ownerOrg: string | null) =>
      recordAudit(db, { action: "DOWNLOAD_DENIED", result: "DENIED", reason: code, actor: user, resource: { type: "DATASET_VERSION", id: versionId, owner_organization_id: ownerOrg }, project_id: projectId, policy_version: POLICY_VERSION });
    // Steps 1-2: version/dataset visible and ACTIVE (INTERNAL of other orgs and WITHDRAWN datasets stay 404).
    let found: ReturnType<typeof visibleVersion>;
    try {
      found = visibleVersion(db, versionId, user);
    } catch (e) {
      audit("NOT_FOUND", null);
      throw e;
    }
    const { v, ds } = found;
    const deny = (code: string, message?: string, details?: Record<string, unknown>): never => {
      audit(code, ds.owner_organization_id);
      return fail(code, message, details);
    };
    if (ds.status !== "ACTIVE") deny("NOT_FOUND");
    if (v.status !== "PUBLISHED") deny("DATASET_VERSION_NOT_PUBLISHED");
    const verified = v.files.filter((f) => f.status === "VERIFIED");
    const missing = (input.file_ids ?? []).filter((id) => !verified.some((f) => f.file_id === id));
    if (missing.length) deny("NOT_FOUND", "File not found.", { file_ids: missing });
    // determine_basis (M04 §6.11)
    const ownOrg = ds.owner_organization_id === user.organization_id;
    const ownerStaff = ownOrg && (user.org_roles.includes("DATA_STEWARD") || user.org_roles.includes("ORG_ADMIN"));
    let basis: Schemas["DownloadSession"]["basis"] = "GRANT";
    if (ds.access_level === "PUBLIC") basis = "PUBLIC";
    else if (ds.access_level === "INTERNAL" || ownerStaff) basis = "OWNER_ORGANIZATION";
    let grantId: string | null = null;
    if (basis === "GRANT") {
      if (!projectId) deny("VALIDATION_FAILED", "project_id is required for grant-based access", { fields: [{ field: "project_id", reason: "REQUIRED" }] });
      const project = db.projects.find((p) => p.project_id === projectId);
      if (!project || !memberOf(db, projectId!, user.user_id)) deny("ACCESS_NOT_PROJECT_MEMBER");
      if (project!.status === "ARCHIVED") deny("PROJECT_ARCHIVED");
      // Latest grant for (user, project, dataset); the lookup key includes project_id, so other projects' grants never match.
      const latest = db.grants
        .filter((g) => g.subject_user_id === user.user_id && g.dataset_id === ds.dataset_id && g.project_id === projectId)
        .map(effective)
        .reverse()
        .sort(newestFirst("valid_from"))[0];
      if (!latest) deny("ACCESS_GRANT_REQUIRED");
      if (latest!.status === "REVOKED") deny("ACCESS_GRANT_REVOKED");
      if (latest!.status === "EXPIRED") deny("ACCESS_GRANT_EXPIRED");
      if (Date.parse(latest!.valid_from) > Date.now()) deny("ACCESS_GRANT_REQUIRED", undefined, { reason: "NOT_YET_VALID" });
      if (!latest!.operations.includes("READ")) deny("ACCESS_GRANT_REQUIRED", undefined, { reason: "OPERATION_MISSING" });
      grantId = latest!.access_grant_id;
    }
    const origin = publicOrigin(request);
    const bucket = bucketOf(db, ds.owner_organization_id);
    const expires = new Date(Date.now() + 300_000).toISOString();
    const files = verified
      .filter((f) => !input.file_ids?.length || input.file_ids.includes(f.file_id))
      .map((f) => ({
        file_id: f.file_id,
        path: f.path,
        size_bytes: f.size_bytes,
        sha256: f.sha256,
        url: `${origin}/mock-storage/${bucket}/datasets/${ds.dataset_id}/${v.dataset_version_id}/${f.path}?X-Mock-Expires=${encodeURIComponent(expires)}`,
      }));
    recordAudit(db, { action: "FILE_DOWNLOADED", actor: user, resource: { type: "DATASET_VERSION", id: v.dataset_version_id, owner_organization_id: ds.owner_organization_id }, project_id: projectId, policy_version: POLICY_VERSION, details: { basis, files: files.length } });
    return HttpResponse.json({ dataset_version_id: v.dataset_version_id, basis, access_grant_id: grantId, expires_at: expires, files }, { status: 201 });
  }),
];
