import { formatBytes } from "@/shared/lib/format";

/** Mirrors apps/api/modules/catalog/domain.py (M03): path_problem, ALLOWED_MEDIA_TYPES, MAX_FILE_BYTES, MAX_PATH_LENGTH. */
export const PATH_RE = /^[A-Za-z0-9._/-]{1,512}$/;
export const MAX_PATH_LENGTH = 512;
export const MAX_FILE_BYTES = 50 * 1024 ** 3;
/** M10 §9 per-selection limit (the server allows more per version; the UI keeps selections reviewable). */
export const MAX_FILES = 500;

/** Extension → the one media type the server accepts for it (exact match, M03 media_type_allowed). */
export const ALLOWED_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".parquet": "application/vnd.apache.parquet",
  ".h5": "application/x-hdf5",
  ".hdf5": "application/x-hdf5",
  ".nc": "application/x-netcdf",
  ".zip": "application/zip",
};

export type PathIssue = "pattern" | "dotdot" | "leading-slash" | "empty-segment";
export type SelectionIssue = { index: number; code: PathIssue | "empty" | "too-large" | "duplicate" | "extension" };

/** Same checks and order as the server's path_problem (LENGTH, CHARACTERS, ABSOLUTE, EMPTY_SEGMENT, DOT_SEGMENT). */
export function validatePath(path: string): PathIssue | null {
  if (!PATH_RE.test(path)) return "pattern";
  if (path.startsWith("/")) return "leading-slash";
  if (path.includes("//") || path.endsWith("/")) return "empty-segment";
  if (path.split("/").some((s) => s === "." || s === "..")) return "dotdot";
  return null;
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

function cleanSegment(segment: string): string {
  return segment
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/_+/g, "_");
}

const MAX_NAME = 128;

/** M10 §9.2 auto-convert: spaces → "_", non-ASCII removed, empty/"."/".." segments dropped, "-1", "-2"… on collision, ≤512. */
export function suggestPath(path: string, taken: ReadonlySet<string>): string {
  const segments = path
    .split("/")
    .map(cleanSegment)
    .map((s) => s.replace(/^_+|_+$/g, ""))
    .filter((s) => s && s !== "." && s !== "..");
  const fileName = segments.pop() ?? "";
  const dot = fileName.lastIndexOf(".");
  const ext = dot >= 0 ? fileName.slice(dot) : "";
  const stem = (dot >= 0 ? fileName.slice(0, dot) : fileName).replace(/^[_.-]+|[_.-]+$/g, "") || "file";
  const build = (n: number) => {
    const suffix = `${n ? `-${n}` : ""}${ext.slice(0, 32)}`;
    const name = `${stem.slice(0, MAX_NAME - suffix.length)}${suffix}`;
    const dir = segments
      .join("/")
      .slice(0, MAX_PATH_LENGTH - 1 - name.length)
      .split("/")
      .filter((s) => s && s !== "." && s !== "..")
      .join("/");
    return dir ? `${dir}/${name}` : name;
  };
  let n = 0;
  while (taken.has(build(n))) n += 1;
  return build(n);
}

export function validateSelection(files: { path: string; size: number }[]): { issues: SelectionIssue[]; tooMany: boolean } {
  const seen = new Set<string>();
  const issues: SelectionIssue[] = [];
  files.forEach((f, index) => {
    const pathIssue = validatePath(f.path);
    if (pathIssue) issues.push({ index, code: pathIssue });
    else if (!(extensionOf(f.path) in ALLOWED_MEDIA_TYPES)) issues.push({ index, code: "extension" });
    if (f.size <= 0) issues.push({ index, code: "empty" });
    if (f.size > MAX_FILE_BYTES) issues.push({ index, code: "too-large" });
    if (seen.has(f.path)) issues.push({ index, code: "duplicate" });
    seen.add(f.path);
  });
  return { issues, tooMany: files.length > MAX_FILES };
}

/** The server requires the media type to equal the extension's canonical type exactly, so the browser's guess never wins. */
export function mediaTypeFor(name: string, browserType: string): string {
  return ALLOWED_MEDIA_TYPES[extensionOf(name)] ?? (browserType || "application/octet-stream");
}

/** ICU params for errors.FILE_TOO_LARGE, upload.dropHint and upload.issue.too-large. */
export function uploadMessageParams(): { max: string } {
  return { max: formatBytes(MAX_FILE_BYTES) };
}
