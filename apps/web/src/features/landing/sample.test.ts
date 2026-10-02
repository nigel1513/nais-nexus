import { describe, expect, it, vi } from "vitest";
import { binRange, SAMPLE_BINS, SAMPLE_COLUMNS } from "./sample";

describe("landing sample columns", () => {
  it("are generated the same way on every import (seeded)", async () => {
    vi.resetModules();
    const again = await import("./sample");
    expect(again.SAMPLE_COLUMNS).toEqual(SAMPLE_COLUMNS);
  });

  it("have a full set of bins, all inside the column range, with a marked peak", () => {
    expect(SAMPLE_COLUMNS.map((c) => c.name)).toEqual(["capacity_ah", "voltage_v", "temp_c", "cycle"]);
    for (const c of SAMPLE_COLUMNS) {
      expect(c.bins).toHaveLength(SAMPLE_BINS);
      expect(c.bins[c.peak]).toBe(Math.max(...c.bins));
      expect(c.bins.reduce((a, b) => a + b, 0)).toBeGreaterThan(2000);
    }
  });

  it("formats bin edges with the column's digits", () => {
    expect(binRange(SAMPLE_COLUMNS[0]!, 0)).toEqual(["2.20", "2.25"]);
    expect(binRange(SAMPLE_COLUMNS[3]!, 21)[1]).toBe("1000");
  });
});
