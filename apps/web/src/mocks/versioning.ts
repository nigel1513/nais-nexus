import type { Schemas } from "@/shared/api/types";

/**
 * Pure mirror of apps/api/modules/catalog/versioning (diff.py, rebase.py, citation.py) and service/history.py.
 * No I/O and never a raw data value (D-018): only paths, sizes, hashes and column structure.
 */
export type FileLite = { path: string; sha256: string; size_bytes: number };
export type FileChange = Schemas["FileChange"];
export type ChangeSummary = Schemas["ChangeSummary"];

/** Paths are ASCII by the upload path pattern, so code-unit order equals the backend's byte order. */
export const byteSort = (paths: Iterable<string>): string[] => [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const side = (f: FileLite | undefined) => (f ? { size_bytes: f.size_bytes, sha256: f.sha256 } : null);

export function diffFiles(before: FileLite[], after: FileLite[]): FileChange[] {
  const b = new Map(before.map((f) => [f.path, f]));
  const a = new Map(after.map((f) => [f.path, f]));
  return byteSort(new Set([...b.keys(), ...a.keys()])).map((path) => {
    const x = b.get(path);
    const y = a.get(path);
    const status = !x ? "ADDED" : !y ? "REMOVED" : y.sha256 !== x.sha256 ? "CHANGED" : "UNCHANGED";
    return { path, status, before: side(x), after: side(y), size_delta: (y?.size_bytes ?? 0) - (x?.size_bytes ?? 0) } as FileChange;
  });
}

export function summarize(changes: Pick<FileChange, "status">[]): ChangeSummary {
  const out: ChangeSummary = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  for (const c of changes) out[c.status.toLowerCase() as keyof ChangeSummary] += 1;
  return out;
}

// ---- schema layer -----------------------------------------------------------------------------------------------
export type ProfileLite = { total_rows?: number | null; columns: { name: string; type: string; unit?: string | null; missing_ratio: number }[] };
const MISSING_RATIO_EPSILON = 0.001;
const pair = <T>(b: T, a: T): [T, T] | null => (b === a ? null : [b, a]);
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

export function diffSchema(path: string, before: ProfileLite | null | undefined, after: ProfileLite | null | undefined): Schemas["SchemaChange"] {
  if (!before || !after) return { path, status: "PROFILE_MISSING" };
  const b = new Map(before.columns.map((c) => [c.name, c]));
  const a = new Map(after.columns.map((c) => [c.name, c]));
  const columns_changed: Schemas["ColumnChange"][] = [];
  for (const [name, y] of a) {
    const x = b.get(name);
    if (!x) continue;
    const ratio = Math.abs(y.missing_ratio - x.missing_ratio) >= MISSING_RATIO_EPSILON ? [round4(x.missing_ratio), round4(y.missing_ratio)] : null;
    const type = pair<string | null>(x.type, y.type);
    const unit = pair<string | null>(x.unit ?? null, y.unit ?? null);
    if (type || unit || ratio) columns_changed.push({ name, type, unit, missing_ratio: ratio });
  }
  return {
    path,
    status: "COMPARED",
    rows: [before.total_rows ?? null, after.total_rows ?? null],
    columns_added: [...a.keys()].filter((n) => !b.has(n)),
    columns_removed: [...b.keys()].filter((n) => !a.has(n)),
    columns_changed,
  };
}

// ---- metadata layer ---------------------------------------------------------------------------------------------
const WHOLE_KEYS = new Set(["people.principal_investigator", "people.steward_contact", "people.contributors"]);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function flatten(snapshot: Record<string, unknown> | null | undefined, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot ?? {})) {
    const dotted = `${prefix}${key}`;
    if (isRecord(value) && !WHOLE_KEYS.has(dotted)) Object.assign(out, flatten(value, `${dotted}.`));
    else out[dotted] = value;
  }
  return out;
}

export const sortKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortKeys) : isRecord(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
const sameValue = (x: unknown, y: unknown) => JSON.stringify(sortKeys(x ?? null)) === JSON.stringify(sortKeys(y ?? null));

export function diffMetadata(before: Record<string, unknown> | null | undefined, after: Record<string, unknown> | null | undefined): Schemas["MetadataChange"][] {
  const b = flatten(before);
  const a = flatten(after);
  return byteSort(new Set([...Object.keys(b), ...Object.keys(a)]))
    .filter((k) => !sameValue(b[k], a[k]))
    .map((field) => ({ field, before: b[field] ?? null, after: a[field] ?? null }));
}

// ---- rebase -----------------------------------------------------------------------------------------------------
export type Conflict = { path: string; base: string | null; mine: string | null; theirs: string | null };
export type RebasePlan = { takeTheirs: string[]; keepMine: string[]; conflicts: Conflict[] };

/** Sides map path -> sha256. Mirrors rebase.three_way; resolutions for non-conflicts throw `UNKNOWN_PATH: p, q`. */
export function threeWay(base: Record<string, string>, mine: Record<string, string>, theirs: Record<string, string>, resolutions: Record<string, string>): RebasePlan {
  const takeTheirs: string[] = [];
  const keepMine: string[] = [];
  const conflicts: Conflict[] = [];
  const conflictPaths = new Set<string>();
  for (const path of byteSort(new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)]))) {
    const b = base[path] ?? null;
    const m = mine[path] ?? null;
    const t = theirs[path] ?? null;
    if (m === b) {
      if (t !== b) takeTheirs.push(path);
    } else if (t === b || m === t) {
      keepMine.push(path);
    } else {
      conflictPaths.add(path);
      const choice = resolutions[path];
      if (choice === "THEIRS") takeTheirs.push(path);
      else if (choice === "MINE") keepMine.push(path);
      else conflicts.push({ path, base: b, mine: m, theirs: t });
    }
  }
  const unknown = byteSort(Object.keys(resolutions).filter((p) => !conflictPaths.has(p)));
  if (unknown.length) throw new Error(`UNKNOWN_PATH: ${unknown.join(", ")}`);
  return { takeTheirs, keepMine, conflicts };
}

// ---- file history -----------------------------------------------------------------------------------------------
export type HistoryVersion = { dataset_version_id: string; version_label: string; published_at: string; files: FileLite[] };

/** `versions` are PUBLISHED/WITHDRAWN and visible to the caller; they are ordered here by published_at, then id. */
export function fileHistory(versions: HistoryVersion[], path: string): Schemas["FileHistoryEntry"][] {
  const ordered = [...versions].sort((a, b) => (a.published_at < b.published_at ? -1 : a.published_at > b.published_at ? 1 : a.dataset_version_id < b.dataset_version_id ? -1 : 1));
  let previous: string | null = null;
  return ordered.map((v) => {
    const row = v.files.find((f) => f.path === path);
    const sha = row?.sha256 ?? null;
    const state = sha === null ? (previous !== null ? "REMOVED" : "ABSENT") : previous === null ? "ADDED" : sha === previous ? "UNCHANGED" : "CHANGED";
    previous = sha;
    return { dataset_version_id: v.dataset_version_id, version_label: v.version_label, published_at: v.published_at, state, sha256: sha, size_bytes: row?.size_bytes ?? null } as Schemas["FileHistoryEntry"];
  });
}

// ---- citation ---------------------------------------------------------------------------------------------------
export type Creator = { name: string; affiliation: string | null; ntis: string | null };
export type CitationInput = {
  title: string;
  version_label: string;
  year: number;
  publisher: string;
  uri: string;
  doi: string | null;
  license: string | null;
  creators: Creator[];
};

const CREATOR_ROLES = new Set(["CO_INVESTIGATOR"]);
type PersonLike = { display_name?: unknown; affiliation?: { name?: string } | null; national_researcher_number?: string | null; role?: unknown };
const person = (p: PersonLike): Creator => ({ name: String(p.display_name), affiliation: p.affiliation?.name ?? null, ntis: p.national_researcher_number ?? null });

export function creatorsFromSnapshot(snapshot: Record<string, unknown>, fallbackOrg: string): Creator[] {
  const people = (snapshot.people ?? {}) as { principal_investigator?: PersonLike | null; contributors?: PersonLike[] };
  const out: Creator[] = [];
  if (people.principal_investigator) out.push(person(people.principal_investigator));
  out.push(...(people.contributors ?? []).filter((c) => CREATOR_ROLES.has(String(c.role))).map(person));
  return out.length ? out : [{ name: fallbackOrg, affiliation: null, ntis: null }];
}

const bib = (v: string) => v.replace(/([{}&%$#_])/g, "\\$1");

export function renderCitation(style: Schemas["CitationStyle"], c: CitationInput): string {
  const names = c.creators.map((x) => x.name).join(", ");
  if (style === "text") return `${names} (${c.year}). ${c.title} (Version ${c.version_label}) [Data set]. ${c.publisher}. ${c.doi ? `https://doi.org/${c.doi}` : c.uri}`;
  if (style === "bibtex") {
    const key = `nais_${(c.uri.split("/").pop() ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 32)}`;
    const fields: [string, string][] = [
      ["author", c.creators.map((x) => bib(x.name)).join(" and ")],
      ["title", bib(c.title)],
      ["version", bib(c.version_label)],
      ["publisher", bib(c.publisher)],
      ["year", String(c.year)],
      ["url", c.uri],
      ...(c.doi ? ([["doi", c.doi]] as [string, string][]) : []),
    ];
    return `@misc{${key},\n${fields.map(([k, v]) => `  ${k} = {${v}},\n`).join("")}}`;
  }
  const creators = c.creators.map((x) => ({
    name: x.name,
    nameType: x.affiliation ? "Personal" : "Organizational",
    ...(x.affiliation ? { affiliation: [{ name: x.affiliation }] } : {}),
    ...(x.ntis ? { nameIdentifiers: [{ nameIdentifier: x.ntis, nameIdentifierScheme: "NTIS" }] } : {}),
  }));
  return JSON.stringify(
    sortKeys({
      creators,
      titles: [{ title: c.title }],
      publisher: { name: c.publisher },
      publicationYear: String(c.year),
      version: c.version_label,
      types: { resourceTypeGeneral: "Dataset" },
      identifiers: [{ identifier: c.uri, identifierType: "URL" }, ...(c.doi ? [{ identifier: c.doi, identifierType: "DOI" }] : [])],
      rightsList: c.license ? [{ rights: c.license }] : [],
    }),
  );
}
