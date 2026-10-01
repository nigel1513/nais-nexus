import { describe, expect, it } from "vitest";
import { profileCsv, SEED_MEASUREMENTS_CSV, UnparseableError } from "./previews";

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

describe("mock profiler (mirror of backend previews/profile.py)", () => {
  it("profiles types, missing ratio, distinct and distributions", () => {
    const { columns, preview } = profileCsv(SEED_MEASUREMENTS_CSV, "data/measurements.csv", {
      temperature_c: { type: "number", unit: "Cel", description: "시편 온도", concept_iri: "http://qudt.org/vocab/quantitykind/Temperature" },
    });
    const temp = columns.find((c) => c.name === "temperature_c")!;
    expect(temp).toMatchObject({ type: "number", unit: "Cel" });
    expect(Object.keys(temp).sort()).toEqual(["concept_iri", "description", "distinct_capped", "distinct_count", "missing_ratio", "name", "type", "unit"]);
    const dist = preview.columns.find((c) => c.name === "temperature_c")!;
    expect(dist.kind).toBe("numeric");
    expect(dist.histogram).toHaveLength(10);
    expect(dist.histogram!.reduce((n, b) => n + b.count, 0)).toBe(1000);
    expect(preview.rows).toHaveLength(100);
    expect(preview.columns.find((c) => c.name === "material")!.kind).toBe("categorical");
  });

  it("truncates cells to 200 chars and keeps the payload ≤ 256 KiB", () => {
    const csv = "a,b\n" + Array.from({ length: 300 }, () => `<script>${"x".repeat(5000)},1`).join("\n");
    const { preview } = profileCsv(csv, "w.csv", {});
    expect(preview.rows.every((r) => (r[0] ?? "").length === 200)).toBe(true);
    expect(bytes(preview)).toBeLessThanOrEqual(256 * 1024);
  });

  it("rejects a physical line over 1 MiB as unparseable (P1)", () => {
    const csv = `a,b\n${"x".repeat(1024 * 1024 + 1)},1\n`;
    expect(() => profileCsv(csv, "big.csv", {})).toThrow(UnparseableError);
  });

  it("caps top_values at 10 and bounds payload by dropping distributions last (P2)", () => {
    const cols = Array.from({ length: 200 }, (_, i) => `c${i}`);
    const rows = Array.from({ length: 40 }, (_, r) => cols.map((_c, i) => `v${(r * 7 + i) % 40}`).join(","));
    const { preview } = profileCsv([cols.join(","), ...rows].join("\n"), "wide.csv", {});
    expect(bytes(preview)).toBeLessThanOrEqual(256 * 1024);
    for (const c of preview.columns) expect(c.top_values?.length ?? 0).toBeLessThanOrEqual(10);
    const wideCells = Array.from({ length: 200 }, (_, i) => `h${i}${"y".repeat(1200)}`);
    const huge = profileCsv([wideCells.join(","), wideCells.map(() => "1").join(",")].join("\n"), "huge.csv", {});
    expect(bytes(huge.preview)).toBeLessThanOrEqual(256 * 1024);
    expect(huge.preview.rows).toEqual([]);
    expect(huge.preview.columns).toEqual([]);
  });
});
