import { describe, expect, it } from "vitest";
import { expiryParts, formatBytes, formatDate, formatDateTime, shortHash } from "./format";

describe("format", () => {
  it("renders UTC instants in Asia/Seoul", () => {
    expect(formatDateTime("2026-10-01T00:00:00Z")).toBe("2026-10-01 09:00");
    expect(formatDateTime("2026-12-31T15:30:00Z")).toBe("2027-01-01 00:30");
    expect(formatDate("2026-12-31T15:30:00Z")).toBe("2027-01-01");
  });

  it("describes expiry relative to now", () => {
    const now = Date.parse("2026-10-01T00:00:00Z");
    expect(expiryParts("2026-10-04T00:00:00Z", now)).toEqual({ key: "common.expiresInDays", count: 3 });
    expect(expiryParts("2026-10-01T05:10:00Z", now)).toEqual({ key: "common.expiresInHours", count: 6 });
    expect(expiryParts("2026-09-30T23:59:59Z", now)).toEqual({ key: "common.expired", count: 0 });
  });

  it("uses binary units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GiB");
    expect(formatBytes(50 * 1024 ** 3)).toBe("50.0 GiB");
  });

  it("shortens hashes", () => {
    expect(shortHash("a".repeat(60) + "b1c2")).toBe("aaaaaaaa…b1c2");
  });
});
