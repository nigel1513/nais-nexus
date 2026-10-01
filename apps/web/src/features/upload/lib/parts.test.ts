import { describe, expect, it } from "vitest";
import { planParts } from "./parts";

const MiB = 1024 * 1024;

describe("planParts (multipart split)", () => {
  it("splits into part_size chunks with a short last part", () => {
    expect(planParts(100 * MiB, 64 * MiB)).toEqual([
      { partNumber: 1, start: 0, end: 64 * MiB },
      { partNumber: 2, start: 64 * MiB, end: 100 * MiB },
    ]);
  });
  it("handles exact multiples and tiny files", () => {
    expect(planParts(128 * MiB, 64 * MiB)).toHaveLength(2);
    expect(planParts(10, 64 * MiB)).toEqual([{ partNumber: 1, start: 0, end: 10 }]);
    expect(planParts(0, 64 * MiB)).toEqual([]);
  });
  it("rejects a non-positive part size instead of looping forever", () => {
    expect(() => planParts(10, 0)).toThrow();
  });
});
