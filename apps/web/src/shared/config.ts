/** Build-time flags. NEXT_PUBLIC_* values are inlined by Next at build time (server and client bundles). */
export const MOCK_USER_COOKIE = "nais_mock_user";
/** Epoch ms of the mock login; the mock API treats signatures older than 5 minutes as needing a fresh login (NOTE_SIGNATURE_EXPIRED). */
export const MOCK_AUTH_TIME_COOKIE = "nais_mock_auth_time";
export const LOCALE_COOKIE = "NEXT_LOCALE";

export function isMocking(): boolean {
  return process.env.NEXT_PUBLIC_API_MOCKING === "enabled";
}

/** Base path of the NAIS API as seen from the browser (same origin, gateway 21051). */
export function apiBase(): string {
  if (isMocking()) return "/mock-api/v1";
  return process.env.NEXT_PUBLIC_API_BASE || "/api/v1";
}
