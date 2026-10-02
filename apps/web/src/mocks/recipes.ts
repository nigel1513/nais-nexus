import type { Schemas } from "@/shared/api/types";
import { DATASET, VERSION } from "./fixtures";
import * as tables from "./seed-tables";
import type { MockDb, StoredVersion } from "./types";

/**
 * Recipe steps on in-memory tables: mirror of apps/api/modules/workspace/recipes/{reader,steps}.py for the mock.
 * CSV columns are typed like the backend reader (integer / float / bool when every value read is a canonical spelling,
 * else text; datetime only through cast_type). Planning = applying the steps to the inputs' empty schemas, so a step
 * that does not fit fails with the same StepError (step_index, reason, column, input_id) the backend's plan() raises.
 * Messages never quote data values.
 */
export type Family = "integer" | "float" | "bool" | "string" | "datetime";
export type Cell = number | string | boolean | null;
export type Table = { names: string[]; types: Family[]; rows: Cell[][] };
type Step = Schemas["RecipeStep"];

export class StepError extends Error {
  constructor(
    public stepIndex: number | null,
    public reason: string,
    message: string,
    public column?: string,
    public inputId?: string,
  ) {
    super(message);
  }

  details(): Record<string, unknown> {
    return { step_index: this.stepIndex, reason: this.reason, ...(this.column !== undefined ? { column: this.column } : {}), ...(this.inputId !== undefined ? { input_id: this.inputId } : {}) };
  }
}

export const PREVIEW_INPUT_ROWS = 10_000;
export const PREVIEW_RESULT_ROWS = 100;
const CELL_CHARS = 200;
const MISSING = new Set(["", "NA", "N/A", "null", "NULL", "NaN"]);
const INTEGER = /^(0|-?[1-9][0-9]*)$/;
const DECIMAL = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$|^-?\.[0-9]+$/;
const BOOLEAN = /^(true|false)$/i;
const OFFSET = /[T ]\d{2}(:?\d{2})?.*(Z|z|[+-]\d{2}(:?\d{2})?)$/;
const LABEL: Record<Family, string> = { integer: "an integer", float: "a number", bool: "a boolean", string: "text", datetime: "a date/time" };
const ORDERED = new Set<Family>(["integer", "float", "string", "datetime"]);
const NUMERIC = new Set<Family>(["integer", "float"]);
const CASTABLE: Record<Schemas["RecipeCastType"], Set<Family>> = {
  int: new Set(["integer", "float", "bool", "string"]),
  float: new Set(["integer", "float", "bool", "string"]),
  string: new Set(["integer", "float", "bool", "string", "datetime"]),
  bool: new Set(["integer", "float", "bool", "string"]),
  datetime: new Set(["string", "datetime"]),
};
const CAST_FAMILY: Record<Schemas["RecipeCastType"], Family> = { int: "integer", float: "float", string: "string", bool: "bool", datetime: "datetime" };

// ---------------------------------------------------------------- reading

/** The topic CSV each seed version's tabular file was profiled from (fixtures.ts tableFor). */
export function seedTableText(datasetId: string, versionId: string, path: string): string | null {
  if (path === "data/test_cells.csv") return tables.batteryCells();
  if (path !== "data/measurements.csv") return null;
  if (datasetId === DATASET.battery) {
    const rows = versionId === VERSION.batteryV10 ? 200 : versionId === VERSION.batteryV11 ? 500 : versionId === VERSION.batteryDraft ? 1200 : 1000;
    return tables.batteryCycles(rows);
  }
  if (datasetId === DATASET.openMaterials) return tables.openMaterials();
  if (datasetId === DATASET.qcLogs) return tables.qcLogs();
  if (datasetId === DATASET.sensors) return tables.sensors();
  return null;
}

/** reader.primary_file: the version's first VERIFIED CSV file (path order; codebooks starting with "_" are not data). */
export function primaryFile(v: StoredVersion) {
  return [...v.files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .find((f) => f.status === "VERIFIED" && /\.csv$/i.test(f.path) && !(f.path.split("/").pop() ?? "").startsWith("_"));
}

export class InputProblem extends Error {
  constructor(public reason: "INPUT_UNAVAILABLE" | "INPUT_NOT_TABULAR" | "INPUT_UNREADABLE") {
    super(reason);
  }
}

function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** CSV text -> typed table of at most `maxRows` rows (reader._read_csv + _typed). */
export function parseCsv(text: string, maxRows = Number.POSITIVE_INFINITY): { table: Table; truncated: boolean } {
  const [header, ...body] = splitCsv(text);
  if (!header || (header.length === 1 && header[0] === "")) throw new InputProblem("INPUT_UNREADABLE");
  if (new Set(header).size !== header.length) throw new InputProblem("INPUT_UNREADABLE");
  const data = body.filter((r) => !(r.length === 1 && r[0] === ""));
  if (data.some((r) => r.length !== header.length)) throw new InputProblem("INPUT_UNREADABLE");
  const read = data.slice(0, maxRows);
  const raw: (string | null)[][] = read.map((r) => r.map((c) => (MISSING.has(c) ? null : c)));
  const types: Family[] = header.map((_, j) => {
    const values = raw.map((r) => r[j]).filter((v): v is string => v !== null).map((v) => v.trim());
    if (!values.length) return "string";
    if (values.every((v) => INTEGER.test(v) && Number.isSafeInteger(Number(v)))) return "integer";
    if (values.every((v) => DECIMAL.test(v) && Number.isFinite(Number(v)))) return "float";
    if (values.every((v) => BOOLEAN.test(v))) return "bool";
    return "string";
  });
  const rows = raw.map((r) =>
    r.map((v, j): Cell => {
      if (v === null) return null;
      const t = types[j]!;
      if (t === "integer" || t === "float") return Number(v.trim());
      if (t === "bool") return v.trim().toLowerCase() === "true";
      return v;
    }),
  );
  return { table: { names: [...header], types, rows }, truncated: data.length > read.length };
}

/** The pinned version's primary table; `maxRows` caps the rows read (preview: 10,000 per input). */
export function readInput(db: MockDb, versionId: string, maxRows?: number): Table {
  const v = db.versions.find((x) => x.dataset_version_id === versionId);
  if (!v || v.status !== "PUBLISHED") throw new InputProblem("INPUT_UNAVAILABLE");
  const file = primaryFile(v);
  if (!file) throw new InputProblem("INPUT_NOT_TABULAR");
  const text = db.objects[file.file_id] ?? seedTableText(v.dataset_id, v.dataset_version_id, file.path);
  if (text === null || text === undefined) throw new InputProblem("INPUT_UNAVAILABLE");
  return parseCsv(text, maxRows).table;
}

// ---------------------------------------------------------------- steps

function parseDatetime(value: string): number | null {
  const v = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|z|[+-]\d{2}:?\d{2})?$/.test(v)) return null;
  const iso = v.replace(" ", "T");
  const ms = Date.parse(OFFSET.test(v) || !iso.includes("T") ? (iso.includes("T") ? iso : `${iso}T00:00:00Z`) : `${iso}Z`);
  return Number.isNaN(ms) ? null : ms;
}

function valueFits(fam: Family, value: unknown, exact = false): boolean {
  if (fam === "integer") return typeof value === "number" && (Number.isInteger(value) || !exact);
  if (fam === "float") return typeof value === "number";
  if (fam === "bool") return typeof value === "boolean";
  if (fam === "string") return typeof value === "string";
  return typeof value === "string" && parseDatetime(value) !== null;
}

const compareCells = (a: Cell, b: Cell): number => {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

class Stepper {
  constructor(
    private index: number,
    private step: Step,
  ) {}

  fail(reason: string, message: string, column?: string, inputId?: string): StepError {
    return new StepError(this.index, reason, `Step ${this.index + 1} (${this.step.type}): ${message}`, column, inputId);
  }

  col(t: Table, name: string, where = ""): number {
    const i = t.names.indexOf(name);
    if (i < 0) throw this.fail("UNKNOWN_COLUMN", `column '${name}' does not exist${where}.`, name);
    return i;
  }

  require(t: Table, name: string, allowed: Set<Family>, need: string): number {
    const i = this.col(t, name);
    if (!allowed.has(t.types[i]!)) throw this.fail("TYPE_MISMATCH", `column '${name}' is ${LABEL[t.types[i]!]}; ${need}.`, name);
    return i;
  }
}

function literal(fam: Family, value: unknown): Cell {
  if (fam === "datetime") return parseDatetime(String(value));
  return value as Cell;
}

function filterRows(p: Stepper, t: Table, s: Extract<Step, { type: "filter_rows" }>): Table {
  const i = p.col(t, s.column);
  const fam = t.types[i]!;
  const missing = (c: Cell) => c === null || (typeof c === "number" && Number.isNaN(c));
  if (s.op === "is_null" || s.op === "not_null") {
    if (s.value !== undefined && s.value !== null) throw p.fail("INVALID_VALUE", `'${s.op}' takes no value.`, s.column);
    return { ...t, rows: t.rows.filter((r) => missing(r[i]!) === (s.op === "is_null")) };
  }
  if (s.value === undefined || s.value === null) throw p.fail("INVALID_VALUE", `'${s.op}' needs a value.`, s.column);
  if (s.op === "contains") {
    p.require(t, s.column, new Set(["string"]), "'contains' needs a text column");
    if (typeof s.value !== "string") throw p.fail("INVALID_VALUE", "'contains' needs a text value.", s.column);
    const needle = s.value;
    return { ...t, rows: t.rows.filter((r) => typeof r[i] === "string" && (r[i] as string).includes(needle)) };
  }
  if (["lt", "le", "gt", "ge"].includes(s.op) && !ORDERED.has(fam)) throw p.fail("TYPE_MISMATCH", `column '${s.column}' is ${LABEL[fam]} and has no order.`, s.column);
  if (s.op === "in" && (!Array.isArray(s.value) || !s.value.length)) throw p.fail("INVALID_VALUE", "'in' needs a non-empty list of values.", s.column);
  if (s.op !== "in" && Array.isArray(s.value)) throw p.fail("INVALID_VALUE", `'${s.op}' needs a single value, not a list.`, s.column);
  const values = (Array.isArray(s.value) ? s.value : [s.value]) as unknown[];
  for (const value of values) {
    if (fam === "datetime" && typeof value === "string" && parseDatetime(value) === null) throw p.fail("INVALID_VALUE", "the value is not an ISO 8601 date/time.", s.column);
    if (!valueFits(fam, value)) throw p.fail("TYPE_MISMATCH", `column '${s.column}' is ${LABEL[fam]}; the value is not.`, s.column);
  }
  const lits = values.map((v) => literal(fam, v));
  const test: Record<string, (c: Cell) => boolean> = {
    eq: (c) => compareCells(c, lits[0]!) === 0,
    ne: (c) => compareCells(c, lits[0]!) !== 0,
    lt: (c) => compareCells(c, lits[0]!) < 0,
    le: (c) => compareCells(c, lits[0]!) <= 0,
    gt: (c) => compareCells(c, lits[0]!) > 0,
    ge: (c) => compareCells(c, lits[0]!) >= 0,
    in: (c) => lits.some((l) => compareCells(c, l) === 0),
  };
  return { ...t, rows: t.rows.filter((r) => !missing(r[i]!) && test[s.op]!(r[i]!)) };
}

function castCell(c: Cell, from: Family, to: Schemas["RecipeCastType"]): Cell | undefined {
  if (c === null) return null;
  const text = typeof c === "string" ? c.trim() : c;
  switch (to) {
    case "int":
      if (typeof text === "boolean") return Number(text);
      if (typeof text === "number") return Number.isInteger(text) ? text : undefined;
      return INTEGER.test(text) || /^[+-]?\d+$/.test(text) ? Number(text) : undefined;
    case "float":
      if (typeof text === "boolean") return Number(text);
      if (typeof text === "number") return text;
      return text !== "" && Number.isFinite(Number(text)) ? Number(text) : undefined;
    case "bool":
      if (typeof text === "boolean") return text;
      if (typeof text === "number") return text !== 0;
      return BOOLEAN.test(text) ? text.toLowerCase() === "true" : undefined;
    case "string":
      return from === "datetime" ? new Date(c as number).toISOString() : cellText(c, from);
    case "datetime":
      if (from === "datetime") return c;
      return parseDatetime(String(text)) ?? undefined;
  }
}

function aggregate(p: Stepper, t: Table, s: Extract<Step, { type: "aggregate" }>): Table {
  const groupIdx = s.group_by.map((g) => p.col(t, g));
  const names = [...s.group_by];
  const types: Family[] = groupIdx.map((i) => t.types[i]!);
  const metrics = s.metrics.map((m) => {
    const i = p.col(t, m.column);
    const fam = t.types[i]!;
    if (m.fn === "sum" || m.fn === "mean") p.require(t, m.column, NUMERIC, `'${m.fn}' needs a numeric column`);
    if ((m.fn === "min" || m.fn === "max") && !(ORDERED.has(fam) || fam === "bool")) throw p.fail("TYPE_MISMATCH", `column '${m.column}' has no order for '${m.fn}'.`, m.column);
    const name = `${m.column}_${m.fn}`;
    if (names.includes(name)) throw p.fail("DUPLICATE_COLUMN", `the result column '${name}' would appear twice.`, name);
    names.push(name);
    types.push(m.fn === "count" ? "integer" : m.fn === "mean" ? "float" : m.fn === "sum" ? (fam === "integer" ? "integer" : "float") : fam);
    return { i, fn: m.fn };
  });
  const groups = new Map<string, { key: Cell[]; rows: Cell[][] }>();
  for (const r of t.rows) {
    const key = groupIdx.map((i) => r[i]!);
    const id = JSON.stringify(key);
    if (!groups.has(id)) groups.set(id, { key, rows: [] });
    groups.get(id)!.rows.push(r);
  }
  const rows = [...groups.values()].map(({ key, rows: members }) => [
    ...key,
    ...metrics.map(({ i, fn }): Cell => {
      const values = members.map((r) => r[i]!).filter((v) => v !== null);
      if (fn === "count") return values.length;
      if (!values.length) return null;
      if (fn === "sum") return (values as number[]).reduce((a, b) => a + b, 0);
      if (fn === "mean") return (values as number[]).reduce((a, b) => a + b, 0) / values.length;
      const sorted = [...values].sort(compareCells);
      return fn === "min" ? sorted[0]! : sorted[sorted.length - 1]!;
    }),
  ]);
  return { names, types, rows };
}

function join(p: Stepper, t: Table, right: Table | undefined, s: Extract<Step, { type: "join" }>): Table {
  if (!right) throw p.fail("UNKNOWN_INPUT", "the joined input is not one of the recipe's inputs.", undefined, s.right_input_id);
  const keys = s.on.map((k) => {
    const li = p.col(t, k);
    const ri = p.col(right, k, " in the joined input");
    const lf = t.types[li]!;
    const rf = right.types[ri]!;
    if (lf !== rf) throw p.fail("TYPE_MISMATCH", `key '${k}' is ${LABEL[lf]} on the left and ${LABEL[rf]} in the joined input; cast one first.`, k);
    return [li, ri] as const;
  });
  const taken = new Set(t.names);
  const payload: { ri: number; name: string }[] = [];
  right.names.forEach((n, ri) => {
    if (s.on.includes(n)) return;
    const name = taken.has(n) ? `${n}_right` : n;
    if (taken.has(name)) throw p.fail("DUPLICATE_COLUMN", `the result column '${name}' would appear twice.`, name);
    taken.add(name);
    payload.push({ ri, name });
  });
  const index = new Map<string, Cell[][]>();
  for (const r of right.rows) {
    const key = keys.map(([, ri]) => r[ri]!);
    if (key.some((k) => k === null)) continue; // null keys never match
    const id = JSON.stringify(key);
    if (!index.has(id)) index.set(id, []);
    index.get(id)!.push(r);
  }
  const rows: Cell[][] = [];
  for (const l of t.rows) {
    const key = keys.map(([li]) => l[li]!);
    const matches = key.some((k) => k === null) ? [] : (index.get(JSON.stringify(key)) ?? []);
    for (const r of matches) rows.push([...l, ...payload.map(({ ri }) => r[ri]!)]);
    if (!matches.length && s.how === "left") rows.push([...l, ...payload.map(() => null)]);
  }
  return { names: [...t.names, ...payload.map((x) => x.name)], types: [...t.types, ...payload.map(({ ri }) => right.types[ri]!)], rows };
}

function applyStep(p: Stepper, t: Table, s: Step, inputs: Map<string, Table>): Table {
  switch (s.type) {
    case "select_columns": {
      const idx = s.columns.map((c) => p.col(t, c));
      return { names: [...s.columns], types: idx.map((i) => t.types[i]!), rows: t.rows.map((r) => idx.map((i) => r[i]!)) };
    }
    case "filter_rows":
      return filterRows(p, t, s);
    case "drop_missing": {
      const idx = s.columns === null ? t.names.map((_, i) => i) : s.columns.map((c) => p.col(t, c));
      return { ...t, rows: t.rows.filter((r) => idx.every((i) => r[i] !== null)) };
    }
    case "fill_missing": {
      const i = p.col(t, s.column);
      if (!valueFits(t.types[i]!, s.value, true)) throw p.fail("TYPE_MISMATCH", `column '${s.column}' is ${LABEL[t.types[i]!]}; the value is not.`, s.column);
      const value = literal(t.types[i]!, s.value);
      return { ...t, rows: t.rows.map((r) => r.map((c, j) => (j === i && c === null ? value : c))) };
    }
    case "cast_type": {
      const i = p.col(t, s.column);
      const from = t.types[i]!;
      if (!CASTABLE[s.to].has(from)) throw p.fail("TYPE_MISMATCH", `column '${s.column}' is ${LABEL[from]} and cannot become ${s.to}.`, s.column);
      const rows = t.rows.map((r) =>
        r.map((c, j) => {
          if (j !== i) return c;
          const out = castCell(c, from, s.to);
          if (out === undefined) throw p.fail("CAST_FAILED", `some values of column '${s.column}' cannot be converted to ${s.to}.`, s.column);
          return out;
        }),
      );
      return { names: t.names, types: t.types.map((f, j) => (j === i ? CAST_FAMILY[s.to] : f)), rows };
    }
    case "convert_unit": {
      const i = p.require(t, s.column, NUMERIC, "unit conversion needs a numeric column");
      return { names: t.names, types: t.types.map((f, j) => (j === i ? "float" : f)), rows: t.rows.map((r) => r.map((c, j) => (j === i && c !== null ? (c as number) * s.factor + s.offset : c))) };
    }
    case "aggregate":
      return aggregate(p, t, s);
    case "join":
      return join(p, t, inputs.get(s.right_input_id), s);
    case "sort": {
      const idx = s.by.map((c) => {
        const i = p.col(t, c);
        if (!(ORDERED.has(t.types[i]!) || t.types[i] === "bool")) throw p.fail("TYPE_MISMATCH", `column '${c}' cannot be sorted.`, c);
        return i;
      });
      const sign = s.descending ? -1 : 1;
      const rows = t.rows
        .map((r, n) => ({ r, n }))
        .sort((a, b) => {
          for (const i of idx) {
            const x = a.r[i]!;
            const y = b.r[i]!;
            if (x === null || y === null) {
              if (x !== y) return x === null ? 1 : -1; // nulls last
              continue;
            }
            const c = compareCells(x, y);
            if (c) return sign * c;
          }
          return a.n - b.n;
        })
        .map(({ r }) => r);
      return { ...t, rows };
    }
    case "limit":
      return { ...t, rows: t.rows.slice(0, s.n) };
  }
}

/** steps.needed_inputs: the base input and every input a join reads, in input_ids order. */
export function neededInputs(steps: Step[], inputIds: string[]): string[] {
  const joined = new Set(steps.flatMap((s) => (s.type === "join" ? [s.right_input_id] : [])));
  return inputIds.filter((id, n) => n === 0 || joined.has(id));
}

/** steps.apply (and, given empty tables, steps.plan). The first input id is the base table. */
export function applySteps(steps: Step[], inputs: Map<string, Table>, inputIds: string[]): Table {
  let t = inputs.get(inputIds[0]!)!;
  steps.forEach((step, index) => {
    if (step.type === "join" && !inputIds.includes(step.right_input_id)) {
      throw new StepError(index, "UNKNOWN_INPUT", `Step ${index + 1} (join): the joined input is not one of the recipe's inputs.`, undefined, step.right_input_id);
    }
    t = applyStep(new Stepper(index, step), t, step, inputs);
  });
  return t;
}

export const schemaOnly = (t: Table): Table => ({ ...t, rows: [] });

function cellText(c: Cell, fam: Family): string | null {
  if (c === null) return null;
  if (fam === "datetime") return new Date(c as number).toISOString().replace(".000Z", "+00:00");
  if (typeof c === "boolean") return c ? "true" : "false";
  if (fam === "float" && typeof c === "number" && Number.isInteger(c)) return c.toFixed(1);
  return String(c);
}

/** steps.preview_rows: the first `limit` rows as strings (≤ 200 characters, null for missing). */
export function previewRows(t: Table, limit = PREVIEW_RESULT_ROWS): (string | null)[][] {
  return t.rows.slice(0, limit).map((r) => r.map((c, j) => cellText(c, t.types[j]!)?.slice(0, CELL_CHARS) ?? null));
}

/** The run result as CSV text (the mock's stand-in for result.parquet bytes). */
export function toCsv(t: Table): string {
  const quote = (v: string | null) => (v === null ? "" : /[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  return [t.names.map(quote).join(","), ...t.rows.map((r) => r.map((c, j) => quote(cellText(c, t.types[j]!))).join(","))].join("\n");
}
