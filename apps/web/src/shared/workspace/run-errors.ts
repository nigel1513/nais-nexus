/**
 * Codes a FAILED run's `error` can hold (mirror of api/modules/workspace/public.py RUN_ERROR_CODES). The UI shows
 * the message workspace.runs.error.<CODE>; an unknown code (or an old `CODE: text` row) falls back to a generic one.
 */
export const RUN_ERROR_CODES = [
  "RECIPE_MISSING",
  "INPUT_ACCESS_LAPSED",
  "RECIPE_INVALID",
  "RESULT_TOO_LARGE",
  "INPUT_UNAVAILABLE",
  "INPUT_NOT_TABULAR",
  "INPUT_TOO_LARGE",
  "INPUT_UNREADABLE",
  "STORAGE_NOT_CONFIGURED",
  "OUT_OF_MEMORY",
  "STORAGE_UNAVAILABLE",
  "INTERNAL_ERROR",
  "RUN_TIMEOUT",
  "STALE_RUN",
] as const;
export type RunErrorCode = (typeof RUN_ERROR_CODES)[number];

/** The message key for a run's error: workspace.runs.error.<CODE>, or .fallback for anything else. */
export function runErrorKey(error: string | null | undefined): `workspace.runs.error.${RunErrorCode | "fallback"}` {
  const code = (error ?? "").split(":", 1)[0]!.trim();
  return (RUN_ERROR_CODES as readonly string[]).includes(code) ? `workspace.runs.error.${code as RunErrorCode}` : "workspace.runs.error.fallback";
}
