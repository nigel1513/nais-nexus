import type { paths } from "@nais/contracts";
import createClient, { type Middleware } from "openapi-fetch";
import { apiBase, isMocking, MOCK_USER_COOKIE } from "@/shared/config";
import { ApiError, networkError, toApiError } from "./errors";

type TokenGetter = () => string | undefined;
let getToken: TokenGetter = () => undefined;

/** Set by <ApiAuthBridge> from the Auth.js session (access token lives in memory only, never in storage). */
export function setAccessTokenGetter(fn: TokenGetter): void {
  getToken = fn;
}

export function getAccessToken(): string | undefined {
  return getToken();
}

export function readCookie(name: string, cookieString: string = typeof document === "undefined" ? "" : document.cookie): string | undefined {
  for (const part of cookieString.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

const requestMiddleware: Middleware = {
  onRequest({ request }) {
    request.headers.set("X-Request-Id", crypto.randomUUID());
    const token = getToken();
    if (token) request.headers.set("Authorization", `Bearer ${token}`);
    if (isMocking()) {
      const user = readCookie(MOCK_USER_COOKIE);
      if (user) request.headers.set("X-Mock-User", user);
      if (typeof window !== "undefined") {
        const code = new URLSearchParams(window.location.search).get("mock_error");
        if (code) request.headers.set("X-Mock-Error", code);
      }
    }
    return request;
  },
};

function resolveBaseUrl(): string {
  const base = apiBase();
  if (typeof window === "undefined") return base;
  return new URL(base, window.location.origin).toString().replace(/\/$/, "");
}

/**
 * The only API client instance (M10 §4). Components never call it directly — use features/<domain>/api.ts hooks.
 * `fetch` is resolved per call so test/mocking layers that patch globalThis.fetch after import still apply.
 */
export const api = createClient<paths>({ baseUrl: resolveBaseUrl(), fetch: (request) => globalThis.fetch(request) });
api.use(requestMiddleware);

type FetchResult<T> = { data?: T; error?: unknown; response: Response };

export async function unwrap<T>(call: Promise<FetchResult<T>>): Promise<T> {
  let result: FetchResult<T>;
  try {
    result = await call;
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    throw networkError(cause);
  }
  if (!result.response.ok) {
    throw toApiError(result.response.status, result.error, result.response.headers.get("X-Request-Id"));
  }
  return result.data as T;
}
