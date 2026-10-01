import { safeCallbackUrl } from "./redirects";

export const LOGIN_PATHS = ["/mock-login", "/web-auth/signin"];

/** Relative sign-in location with a sanitized same-origin callback. */
export function loginLocation(loginPath: string, callbackUrl: string | null): string {
  return `${loginPath}?callbackUrl=${encodeURIComponent(safeCallbackUrl(callbackUrl))}`;
}

/** Internal request headers carrying the sign-in target from the middleware rewrite to /auth-redirect (query params do not survive a rewrite to a route handler). */
export const LOGIN_HEADER = "x-nais-login";
export const CALLBACK_HEADER = "x-nais-callback";
