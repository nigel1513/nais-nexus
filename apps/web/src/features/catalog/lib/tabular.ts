const TABULAR = new Set(["csv", "tsv", "parquet"]);

/** Tabular = csv/tsv/parquet by extension; `_`-prefixed basenames (e.g. `_schema.json`) are metadata, not data. */
export function isTabular(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  if (base.startsWith("_")) return false;
  const dot = base.lastIndexOf(".");
  return dot > 0 && TABULAR.has(base.slice(dot + 1).toLowerCase());
}
