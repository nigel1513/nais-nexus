import type { Schemas } from "@/shared/api/types";

/** Mirror of apps/api/modules/catalog/previews/profile.py (limits, inference, distributions). Mock-only. */
export type Hint = { type?: Schemas["ColumnProfile"]["type"] | null; unit?: string | null; description?: string | null; concept_iri?: string | null };
const MISSING = new Set(["", "NA", "N/A", "null", "NULL", "NaN"]);
const L = { maxLineBytes: 1024 * 1024, maxRows: 10_000, maxColumns: 200, previewRows: 100, cellChars: 200, previewBytes: 256 * 1024, distinctCap: 1_000, bins: 10, top: 10, categoricalMax: 50 };
const RX = { integer: /^[+-]?[0-9]+$/, number: /^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$/, date: /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, datetime: /^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:?[0-9]{2})?$/ };
const BOOL = new Set(["true", "false", "True", "False", "TRUE", "FALSE"]);
const ORDER = ["integer", "number", "boolean", "date", "datetime"] as const;

function splitCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export class UnparseableError extends Error {}

export type PreviewBody = Omit<Schemas["FilePreview"], "file_id" | "status">;

export function profileCsv(text: string, path: string, hints: Record<string, Hint>) {
  // P1: a physical line over 1 MiB is UNPARSEABLE, never "READY with 0 rows".
  if (text.split(/\r\n|\r|\n/).some((line) => new TextEncoder().encode(line).length > L.maxLineBytes)) throw new UnparseableError("line exceeds 1 MiB");
  const [header = [], ...body] = splitCsv(text.replace(/^﻿/, ""), path.toLowerCase().endsWith(".tsv") ? "\t" : ",");
  const names = header.slice(0, L.maxColumns);
  const rows = body.filter((r) => r.length === header.length).slice(0, L.maxRows);
  const columns: Schemas["ColumnProfile"][] = [];
  const dists: Schemas["ColumnDistribution"][] = [];
  names.forEach((name, ci) => {
    const values = rows.map((r) => r[ci]!);
    const present = values.filter((v) => !MISSING.has(v));
    const distinct = new Set(present.slice(0, 50_000));
    const hint = hints[name] ?? {};
    const hits = (t: (typeof ORDER)[number]) => present.filter((v) => (t === "boolean" ? BOOL.has(v) : v.length <= 64 && RX[t].test(v))).length;
    const type = hint.type ?? (present.length ? ORDER.find((t) => hits(t) === present.length) ?? "string" : "string");
    const capped = distinct.size > L.distinctCap;
    columns.push({ name, type, unit: hint.unit ?? null, description: hint.description ?? null, concept_iri: hint.concept_iri ?? null, missing_ratio: values.length ? +(1 - present.length / values.length).toFixed(6) : 0, distinct_count: Math.min(distinct.size, L.distinctCap + 1), distinct_capped: capped });
    const nums = (type === "integer" || type === "number") ? present.map(Number).filter(Number.isFinite) : [];
    if (nums.length) {
      const min = Math.min(...nums), max = Math.max(...nums), width = (max - min) / L.bins;
      const counts = Array<number>(L.bins).fill(0);
      for (const x of nums) counts[width ? Math.min(Math.floor((x - min) / width), L.bins - 1) : 0]! += 1;
      const histogram = width ? counts.map((count, i) => ({ lower: +(min + i * width).toFixed(6), upper: +(min + (i + 1) * width).toFixed(6), count })) : [{ lower: min, upper: max, count: nums.length }];
      dists.push({ name, kind: "numeric", min, max, mean: +(nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(6), histogram });
    } else if (type === "boolean" || (!capped && distinct.size <= L.categoricalMax)) {
      const counts = new Map<string, number>();
      for (const v of present) counts.set(v.slice(0, L.cellChars), (counts.get(v.slice(0, L.cellChars)) ?? 0) + 1);
      dists.push({ name, kind: "categorical", top_values: [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, L.top).map(([value, count]) => ({ value, count })) });
    } else dists.push({ name, kind: "other" });
  });
  const preview: PreviewBody = { header: names, rows: rows.slice(0, L.previewRows).map((r) => r.slice(0, L.maxColumns).map((v) => (MISSING.has(v) ? null : v.slice(0, L.cellChars)))), rows_truncated: false, columns: dists };
  const size = () => new TextEncoder().encode(JSON.stringify(preview)).length;
  while (preview.rows.length && size() > L.previewBytes) {
    preview.rows = preview.rows.slice(0, Math.floor((preview.rows.length * 3) / 4));
    preview.rows_truncated = true;
  }
  // P2: still too large with no rows left — drop the distributions too.
  if (size() > L.previewBytes) {
    preview.columns = [];
  }
  return { columns, preview, rowsSampled: rows.length, truncated: body.length > L.maxRows, columnsTruncated: header.length > L.maxColumns };
}

/** Deterministic stand-in for the seed data/measurements.csv (09 §5 columns). */
export const SEED_MEASUREMENTS_CSV = ["sample_id,temperature_c,pressure_kpa,material,measured_at",
  ...Array.from({ length: 1000 }, (_, i) => `S${String(i).padStart(4, "0")},${(20 + (i % 61) + 0.5).toFixed(1)},${(100 + (i % 37) * 2.5).toFixed(1)},${["AL", "CU", "FE"][i % 3]},2026-01-01T${String(Math.floor(i / 60) % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`)].join("\n");
