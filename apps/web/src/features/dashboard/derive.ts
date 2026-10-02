import type { AccessGrant, AccessRequest, AuditAction, AuditEvent } from "@/shared/api/types";

/**
 * Pure derivations behind the dashboard: every figure is counted from what the API returned (audit events, requests,
 * grants, search totals and facets). Nothing here invents a number.
 */

export const DAY_MS = 86_400_000;
export const WINDOW_DAYS = 30;
const KST_MS = 9 * 3_600_000;

/** Activity kinds, in the fixed series order (stack bottom → top; colour slot = index + 1). "other" folds the rest. */
export const KINDS = ["download", "access", "publish", "readiness", "other"] as const;
export type Kind = (typeof KINDS)[number];

const KIND_OF: Partial<Record<AuditAction, Kind>> = {
  FILE_DOWNLOADED: "download",
  DOWNLOAD_DENIED: "download",
  ACCESS_REQUESTED: "access",
  ACCESS_REVIEW_STARTED: "access",
  ACCESS_APPROVED: "access",
  ACCESS_REJECTED: "access",
  ACCESS_CHANGES_REQUESTED: "access",
  ACCESS_WITHDRAWN: "access",
  ACCESS_REVOKED: "access",
  ACCESS_EXPIRED: "access",
  DATASET_CREATED: "publish",
  DATASET_VERSION_PUBLISHED: "publish",
  DATASET_UPDATED: "publish",
  POLICY_CHANGED: "publish",
  READINESS_VALIDATION_COMPLETED: "readiness",
};
export const kindOf = (action: AuditAction): Kind => KIND_OF[action] ?? "other";

/** Calendar day in Asia/Seoul as "YYYY-MM-DD" (the portal's working day). */
export const dayKey = (ms: number) => new Date(ms + KST_MS).toISOString().slice(0, 10);

/** Start of the window: KST midnight `days - 1` days before today, so the window holds `days` whole days incl. today. */
export function windowStart(now: number, days = WINDOW_DAYS): number {
  const midnight = Math.floor((now + KST_MS) / DAY_MS) * DAY_MS - KST_MS;
  return midnight - (days - 1) * DAY_MS;
}

export function dayKeys(now: number, days = WINDOW_DAYS): string[] {
  const start = windowStart(now, days);
  return Array.from({ length: days }, (_, i) => dayKey(start + i * DAY_MS + 12 * 3_600_000));
}

export type DayBucket = { key: string; counts: Record<Kind, number>; total: number };

export function bucketByDay(events: AuditEvent[], keys: string[]): DayBucket[] {
  const index = new Map(keys.map((k, i) => [k, i]));
  const buckets: DayBucket[] = keys.map((key) => ({ key, counts: { download: 0, access: 0, publish: 0, readiness: 0, other: 0 }, total: 0 }));
  for (const e of events) {
    const i = index.get(dayKey(Date.parse(e.occurred_at)));
    if (i === undefined) continue;
    const b = buckets[i]!;
    b.counts[kindOf(e.action)] += 1;
    b.total += 1;
  }
  return buckets;
}

/** Daily counts of the events that match `pick`, aligned to `keys`. */
export function dailySeries(events: AuditEvent[], keys: string[], pick: (e: AuditEvent) => boolean): number[] {
  const index = new Map(keys.map((k, i) => [k, i]));
  const out = keys.map(() => 0);
  for (const e of events) {
    if (!pick(e)) continue;
    const i = index.get(dayKey(Date.parse(e.occurred_at)));
    if (i !== undefined) out[i] = out[i]! + 1;
  }
  return out;
}

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Running total that ends at `end` (a current total), stepping by the daily additions. */
export function cumulativeEndingAt(daily: number[], end: number): number[] {
  let level = end - sum(daily);
  return daily.map((d) => (level += d));
}

/** Last 7 days against the 7 before them, or null when the earlier week is empty (no honest ratio). */
export function weekOverWeek(daily: number[]): { current: number; previous: number; ratio: number | null } {
  const current = sum(daily.slice(-7));
  const previous = sum(daily.slice(-14, -7));
  return { current, previous, ratio: previous > 0 ? (current - previous) / previous : null };
}

const DECIDED = new Set(["APPROVED", "REJECTED", "CHANGE_REQUESTED"]);

/** Requests decided inside the window and the mean days from submission to that decision. */
export function decisions(requests: AccessRequest[], since: number): { count: number; meanDays: number | null } {
  const spans: number[] = [];
  for (const r of requests) {
    const decided = (r.history ?? []).find((h) => DECIDED.has(h.status));
    if (!decided || Date.parse(decided.at) < since) continue;
    spans.push((Date.parse(decided.at) - Date.parse(r.created_at)) / DAY_MS);
  }
  return { count: spans.length, meanDays: spans.length ? sum(spans) / spans.length : null };
}

export const daysUntil = (iso: string, now: number) => Math.max(0, Math.ceil((Date.parse(iso) - now) / DAY_MS));
export const daysSince = (iso: string, now: number) => Math.max(0, Math.floor((now - Date.parse(iso)) / DAY_MS));

/** Share of the grant's period still left (1 = just granted, 0 = ends now). */
export function remainingShare(g: Pick<AccessGrant, "valid_from" | "expires_at">, now: number): number {
  const total = Date.parse(g.expires_at) - Date.parse(g.valid_from);
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, (Date.parse(g.expires_at) - now) / total));
}

/** "Nice" axis maximum and ticks for a count axis (0 / 5 / 10 …). */
export function niceTicks(max: number, count = 3): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
}

/** Same actor, action and result in a row collapse into one line ("×6"), so system batches do not flood a feed. */
export function groupRuns(events: AuditEvent[]): { event: AuditEvent; repeat: number }[] {
  const rows: { event: AuditEvent; repeat: number }[] = [];
  for (const e of events) {
    const last = rows.at(-1);
    const same =
      last &&
      last.event.action === e.action &&
      last.event.result === e.result &&
      (last.event.actor.user_id ?? null) === (e.actor.user_id ?? null) &&
      last.event.actor.type === e.actor.type;
    if (same) last.repeat += 1;
    else rows.push({ event: e, repeat: 1 });
  }
  return rows;
}
