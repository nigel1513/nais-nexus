import { describe, expect, it } from "vitest";
import { sampleHistogram, sampleSeries } from "./sample";

describe("landing sample figure data", () => {
  it("is deterministic, so server and client renders and screenshots never differ", () => {
    expect(sampleHistogram()).toEqual(sampleHistogram());
    expect(sampleSeries("voltage")).toEqual(sampleSeries("voltage"));
  });

  it("histogram bins are normalised to 0..1 with a full-height peak", () => {
    const bins = sampleHistogram();
    expect(bins).toHaveLength(32);
    expect(Math.max(...bins)).toBe(1);
    expect(bins.every((b) => b >= 0 && b <= 1)).toBe(true);
  });

  it("series are normalised to 0..1 and capacity fades over cycles", () => {
    for (const kind of ["voltage", "temperature", "capacity"] as const) {
      const s = sampleSeries(kind);
      expect(s).toHaveLength(48);
      expect(Math.min(...s)).toBeCloseTo(0);
      expect(Math.max(...s)).toBeCloseTo(1);
    }
    const cap = sampleSeries("capacity");
    expect(cap[0]!).toBeGreaterThan(cap.at(-1)!);
  });
});
