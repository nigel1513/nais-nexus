import { ERROR_CODES } from "@/generated/contracts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly traceId: string | null,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const BLOCKED_CODES = ["USER_DISABLED", "MEMBERSHIP_DISABLED", "ORGANIZATION_UNKNOWN"] as const;

function codeForStatus(status: number): string {
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 422) return "VALIDATION_FAILED";
  if (status === 429) return "RATE_LIMITED";
  if (status === 502 || status === 503 || status === 504) return "DEPENDENCY_UNAVAILABLE";
  return "INTERNAL_ERROR";
}

export function toApiError(status: number, body: unknown, requestId?: string | null): ApiError {
  const envelope = body && typeof body === "object" ? (body as { error?: Record<string, unknown> }).error : undefined;
  if (envelope && typeof envelope.code === "string") {
    const details = envelope.details && typeof envelope.details === "object" ? (envelope.details as Record<string, unknown>) : {};
    return new ApiError(
      status,
      envelope.code,
      typeof envelope.message === "string" ? envelope.message : envelope.code,
      typeof envelope.trace_id === "string" ? envelope.trace_id : (requestId ?? null),
      details,
    );
  }
  return new ApiError(status, codeForStatus(status), `HTTP ${status}`, requestId ?? null);
}

export function networkError(cause: unknown): ApiError {
  return new ApiError(0, "DEPENDENCY_UNAVAILABLE", cause instanceof Error ? cause.message : "network error", null);
}

export function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(0, "INTERNAL_ERROR", error instanceof Error ? error.message : String(error), null);
}

const KNOWN = new Set<string>(ERROR_CODES);

export function errorMessageKey(code: string): string {
  return KNOWN.has(code) ? `errors.${code}` : "errors.fallback";
}

export function isBlockedCode(code: string): boolean {
  return (BLOCKED_CODES as readonly string[]).includes(code);
}

/** VALIDATION_FAILED details.fields → { field: message } for React Hook Form setError. */
export function fieldErrors(error: ApiError): Record<string, string> {
  const fields = error.details.fields;
  if (Array.isArray(fields)) {
    return Object.fromEntries(
      fields
        .filter((f): f is { field: string; message?: string } => !!f && typeof f === "object" && typeof (f as { field?: unknown }).field === "string")
        .map((f) => [f.field, String(f.message ?? "")]),
    );
  }
  if (fields && typeof fields === "object") {
    return Object.fromEntries(Object.entries(fields as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
  }
  return {};
}
