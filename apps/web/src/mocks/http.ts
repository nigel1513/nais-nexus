import { HttpResponse } from "msw";
import { ERROR_HTTP } from "@/generated/contracts";
import type { Schemas } from "@/shared/api/types";
import { MOCK_AUTH_TIME_COOKIE, MOCK_USER_COOKIE } from "@/shared/config";
import { getDb } from "./db";
import type { MockDb, MockUser } from "./types";

export const API = "*/mock-api/v1";

export const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();
const traceId = () => crypto.randomUUID().replaceAll("-", "");

export function apiError(code: string, message: string = code, details?: Record<string, unknown>) {
  return HttpResponse.json(
    { error: { code, message, trace_id: traceId(), ...(details ? { details } : {}) } },
    { status: ERROR_HTTP[code] ?? 500 },
  );
}

/** Short-circuit a resolver with an error envelope (MSW treats a thrown Response as the mocked response). */
export function fail(code: string, message?: string, details?: Record<string, unknown>): never {
  if (!(code in ERROR_HTTP)) throw new Error(`Unknown error code passed to fail(): ${code}`);
  throw apiError(code, message ?? code, details);
}

function cookie(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export function currentUser(request: Request): MockUser {
  const id = request.headers.get("x-mock-user") ?? cookie(request.headers.get("cookie"), MOCK_USER_COOKIE);
  if (!id) fail("UNAUTHENTICATED", "Mock session missing");
  const user = getDb().users.find((u) => u.user_id === id);
  if (!user) fail("UNAUTHENTICATED", "Unknown mock user");
  if (user.status === "DISABLED") fail("USER_DISABLED");
  if (user.membership_status === "DISABLED") fail("MEMBERSHIP_DISABLED");
  return user;
}

/** Real error shape: details.fields is a list of { field, reason } (service._validation_error). */
export function validationFailed(field: string, reason: string, message = "Request validation failed."): never {
  return fail("VALIDATION_FAILED", message, { fields: [{ field, reason }] });
}

export function paginate<T>(items: T[], url: URL) {
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) validationFailed("limit", "OUT_OF_RANGE", "limit must be between 1 and 100.");
  const rawCursor = url.searchParams.get("cursor");
  const offset = rawCursor === null ? 0 : Number(rawCursor);
  if (!Number.isInteger(offset) || offset < 0) validationFailed("cursor", "INVALID_CURSOR", "Invalid pagination cursor.");
  const next = offset + limit;
  const hasMore = next < items.length;
  return { items: items.slice(offset, next), page: { has_more: hasMore, next_cursor: hasMore ? String(next) : null } };
}

export async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    fail("VALIDATION_FAILED", "Invalid JSON body");
  }
}

/** Comparator for ISO timestamps (or any string) — newest first. */
export function newestFirst<K extends string>(key: K) {
  return (a: Partial<Record<K, unknown>>, b: Partial<Record<K, unknown>>) => String(b[key] ?? "").localeCompare(String(a[key] ?? ""));
}

/** Absolute same-origin base for presigned-style URLs (gateway keeps Host = localhost:21051 or the external host). */
export function publicOrigin(request: Request): string {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) return new URL(request.url).origin;
  const proto = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
  return `${proto}://${host}`;
}

export function orgName(db: MockDb, id: string): string {
  return db.organizations.find((o) => o.organization_id === id)?.name ?? id;
}

export function recordAudit(
  db: MockDb,
  e: {
    action: Schemas["AuditAction"];
    actor: MockUser | null;
    resource: { type: Schemas["ResourceType"]; id: string; owner_organization_id?: string | null };
    result?: "SUCCESS" | "DENIED";
    reason?: string | null;
    project_id?: string | null;
    policy_version?: string | null;
    details?: Record<string, unknown>;
  },
): void {
  db.audit.push({
    audit_event_id: newId(),
    occurred_at: nowIso(),
    action: e.action,
    result: e.result ?? "SUCCESS",
    reason: e.reason ?? null,
    actor: e.actor
      ? { type: "USER", user_id: e.actor.user_id, display_name: e.actor.display_name, organization_id: e.actor.organization_id }
      : { type: "SYSTEM", user_id: null, display_name: null, organization_id: null },
    resource: { type: e.resource.type, id: e.resource.id, owner_organization_id: e.resource.owner_organization_id ?? null },
    project_id: e.project_id ?? null,
    policy_version: e.policy_version ?? null,
    source_event_id: newId(),
    source_event_type: "mock.v1",
    trace_id: traceId(),
    details: e.details ?? {},
  });
}

export function notify(db: MockDb, userIds: string[], type: Schemas["NotificationType"], title: string, link: string, bodyText?: string): void {
  for (const user_id of new Set(userIds)) {
    db.notifications.push({ notification_id: newId(), user_id, type, title, body: bodyText, link, read: false, created_at: nowIso() });
  }
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_PATTERN.test(v);

/** A JSON object with only the model's keys (pydantic extra="forbid"): else 422 with the first offending field. */
export function only(raw: unknown, allowed: string[], field = "body"): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) validationFailed(field, "INVALID_TYPE");
  const extra = Object.keys(raw as object).find((k) => !allowed.includes(k));
  if (extra) validationFailed(field === "body" ? extra : `${field}.${extra}`, "EXTRA_FORBIDDEN");
  return raw as Record<string, unknown>;
}

/** An optional request body (`requestBody.required: false`): no body is `{}`, malformed JSON is 422. */
export async function optionalBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    fail("VALIDATION_FAILED", "Invalid JSON body");
  }
}

/** If-Match: the current version / revision, optionally quoted; missing or malformed is 422. */
export function ifMatch(request: Request): number {
  const raw = request.headers.get("if-match");
  const m = raw ? /^"?([1-9][0-9]*)"?$/.exec(raw.trim()) : null;
  if (!m) validationFailed("If-Match", raw ? "INVALID" : "MISSING");
  return Number(m[1]);
}

export const displayName = (db: MockDb, userId: string) => db.users.find((u) => u.user_id === userId)?.display_name ?? "";
export const projectName = (db: MockDb, projectId: string) => db.projects.find((p) => p.project_id === projectId)?.name ?? "";

/** Login time of the mock session (mock-login sets it); null when the caller sent none (header-only test clients). */
export function mockAuthTime(request: Request): number | null {
  const raw = cookie(request.headers.get("cookie"), MOCK_AUTH_TIME_COOKIE);
  const ms = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(ms) ? ms : null;
}
