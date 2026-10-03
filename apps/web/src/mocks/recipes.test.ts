import { describe, expect, it } from "vitest";
import { applySteps, parseCsv, previewRows, primaryFile, schemaOnly, StepError, type Table } from "./recipes";
import type { StoredVersion } from "./types";

const L = "left-input";
const R = "right-input";
const tables = (left: string, right?: string) => new Map<string, Table>([[L, parseCsv(left).table], ...(right ? [[R, parseCsv(right).table] as [string, Table]] : [])]);

describe("mock recipe engine", () => {
  it("types CSV columns like the backend reader (canonical numbers only, missing tokens are null)", () => {
    const { table } = parseCsv("id,zip,x,flag,label\n1,007,1.5,true,a\n2,010,NA,FALSE,b\n");
    expect(table.types).toEqual(["integer", "string", "float", "bool", "string"]);
    expect(table.rows[1]).toEqual([2, "010", null, false, "b"]);
  });

  it("joins, aggregates and sorts with backend naming (_right suffix, <column>_<fn>, nulls last)", () => {
    const t = tables("cell,temp\nC1,24.5\nC2,26\nC1,25.5\nC3,\n", "cell,temp,chem\nC1,0,NCM\nC2,1,SiC\n");
    const joined = applySteps([{ type: "join", right_input_id: R, on: ["cell"], how: "left" }], t, [L, R]);
    expect(joined.names).toEqual(["cell", "temp", "temp_right", "chem"]);
    expect(joined.rows.at(-1)).toEqual(["C3", null, null, null]);
    const agg = applySteps(
      [
        { type: "aggregate", group_by: ["cell"], metrics: [{ column: "temp", fn: "mean" }, { column: "temp", fn: "count" }] },
        { type: "sort", by: ["temp_mean"], descending: true },
      ],
      t,
      [L],
    );
    expect(previewRows(agg)).toEqual([
      ["C2", "26.0", "1"],
      ["C1", "25.0", "2"],
      ["C3", null, "0"],
    ]);
  });

  it("plans on empty schemas with the same step errors and fails casts at execution only", () => {
    const t = tables("cell,temp\nC1,warm\n");
    const schema = new Map([...t].map(([k, v]) => [k, schemaOnly(v)]));
    const cast = [{ type: "cast_type" as const, column: "temp", to: "float" as const }];
    expect(() => applySteps(cast, schema, [L])).not.toThrow();
    expect(() => applySteps(cast, t, [L])).toThrow(expect.objectContaining({ reason: "CAST_FAILED", stepIndex: 0 }) as unknown as StepError);
    expect(() => applySteps([{ type: "convert_unit", column: "cell", factor: 1, offset: 0, unit_label: "K" }], schema, [L])).toThrow(expect.objectContaining({ reason: "TYPE_MISMATCH", column: "cell" }) as unknown as StepError);
    expect(() => applySteps([{ type: "filter_rows", column: "cell", op: "lt", value: 3 }], schema, [L])).toThrow(expect.objectContaining({ reason: "TYPE_MISMATCH" }) as unknown as StepError);
  });

  it("picks the largest VERIFIED table and never a codebook, wherever it is listed (reader.primary_file)", () => {
    const file = (path: string, size_bytes: number, status: "VERIFIED" | "PENDING" = "VERIFIED") => ({ file_id: path, path, size_bytes, sha256: "0".repeat(64), media_type: "text/csv", status });
    const v = (files: ReturnType<typeof file>[]) => ({ files }) as unknown as StoredVersion;
    expect(primaryFile(v([file("_codebook.csv", 9000), file("data/test_cells.csv", 300), file("data/measurements.csv", 4000), file("big.csv", 9999, "PENDING")]))?.path).toBe("data/measurements.csv");
    expect(primaryFile(v([file("_codebook.csv", 10)]))).toBeUndefined();
    expect(primaryFile(v([file("b.csv", 5), file("a.csv", 5)]))?.path).toBe("a.csv");
  });
});
