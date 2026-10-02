// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AccessRequest, AuditEvent } from "@/shared/api/types";
import { bucketByDay, cumulativeEndingAt, dailySeries, DAY_MS, dayKey, dayKeys, decisions, groupRuns, kindOf, niceTicks, remainingShare, weekOverWeek, windowStart } from "./derive";

const NOW = Date.parse("2026-10-02T05:00:00Z"); // 14:00 KST, Friday
const ev = (action: AuditEvent["action"], at: string, user: string | null = "u1"): AuditEvent =>
  ({
    audit_event_id: `${action}-${at}`,
    occurred_at: at,
    action,
    result: "SUCCESS",
    actor: user ? { type: "USER", user_id: user, display_name: "x", organization_id: "o" } : { type: "SYSTEM", user_id: null, display_name: null, organization_id: null },
    resource: { type: "DATASET", id: "d", owner_organization_id: "o" },
  }) as AuditEvent;

describe("dashboard derivations", () => {
  it("30 Seoul calendar days ending today; the window starts at KST midnight", () => {
    const keys = dayKeys(NOW);
    expect(keys).toHaveLength(30);
    expect(keys.at(-1)).toBe("2026-10-02");
    expect(keys[0]).toBe("2026-09-03");
    expect(dayKey(windowStart(NOW))).toBe("2026-09-03");
    expect(new Date(windowStart(NOW)).toISOString()).toBe("2026-09-02T15:00:00.000Z");
    // 23:30 UTC on Oct 1 is already Oct 2 in Seoul.
    expect(dayKey(Date.parse("2026-10-01T23:30:00Z"))).toBe("2026-10-02");
  });

  it("buckets events by day and kind, ignoring anything outside the window", () => {
    const keys = dayKeys(NOW);
    const buckets = bucketByDay(
      [ev("FILE_DOWNLOADED", "2026-10-02T01:00:00Z"), ev("ACCESS_APPROVED", "2026-10-02T02:00:00Z"), ev("PROJECT_CREATED", "2026-10-01T02:00:00Z"), ev("FILE_DOWNLOADED", "2026-08-01T02:00:00Z")],
      keys,
    );
    expect(buckets.at(-1)).toMatchObject({ total: 2, counts: { download: 1, access: 1 } });
    expect(buckets.at(-2)).toMatchObject({ total: 1, counts: { other: 1 } });
    expect(buckets.reduce((n, b) => n + b.total, 0)).toBe(3);
    expect(kindOf("READINESS_VALIDATION_COMPLETED")).toBe("readiness");
    expect(kindOf("DATASET_VERSION_PUBLISHED")).toBe("publish");
    expect(dailySeries([ev("FILE_DOWNLOADED", "2026-10-02T01:00:00Z")], keys, (e) => e.action === "FILE_DOWNLOADED").at(-1)).toBe(1);
  });

  it("running totals end at the current total; week-over-week has no ratio without a previous week", () => {
    expect(cumulativeEndingAt([0, 1, 0, 2], 10)).toEqual([7, 8, 8, 10]);
    const daily = Array.from({ length: 30 }, (_, i) => (i >= 23 ? 2 : 0));
    expect(weekOverWeek(daily)).toEqual({ current: 14, previous: 0, ratio: null });
    const steady = Array.from({ length: 30 }, (_, i) => (i >= 16 && i < 23 ? 1 : i >= 23 ? 2 : 0));
    expect(weekOverWeek(steady).ratio).toBe(1);
  });

  it("decision time counts only requests decided inside the window", () => {
    const req = (created: string, decided: string | null) =>
      ({ created_at: created, history: [{ status: "SUBMITTED", at: created }, ...(decided ? [{ status: "APPROVED", at: decided }] : [])] }) as AccessRequest;
    const since = windowStart(NOW);
    const d = decisions([req("2026-09-20T00:00:00Z", "2026-09-22T00:00:00Z"), req("2026-09-25T00:00:00Z", "2026-09-26T00:00:00Z"), req("2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z"), req("2026-09-30T00:00:00Z", null)], since);
    expect(d).toEqual({ count: 2, meanDays: 1.5 });
  });

  it("remaining share, nice ticks and run grouping", () => {
    expect(remainingShare({ valid_from: new Date(NOW - 8 * DAY_MS).toISOString(), expires_at: new Date(NOW + 2 * DAY_MS).toISOString() }, NOW)).toBeCloseTo(0.2);
    expect(niceTicks(13)).toEqual([0, 5, 10, 15]);
    expect(niceTicks(3)).toEqual([0, 1, 2, 3]);
    expect(niceTicks(0)).toEqual([0, 1]);
    const runs = groupRuns([ev("READINESS_VALIDATION_COMPLETED", "a", null), ev("READINESS_VALIDATION_COMPLETED", "b", null), ev("FILE_DOWNLOADED", "c")]);
    expect(runs.map((r) => r.repeat)).toEqual([2, 1]);
  });
});
