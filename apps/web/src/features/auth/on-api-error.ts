import { ApiError, isBlockedCode } from "@/shared/api/errors";
import { isProtected } from "./redirects";

const AUTH_PATHS = [/^\/blocked(\/|$)/, /^\/web-auth(\/|$)/, /^\/mock-login(\/|$)/];
/**
 * 401s that are answers for the screen, not a lost session: signNote's NOTE_SIGNATURE_EXPIRED (the login is older than
 * 5 minutes) is handled by the sign dialog, which re-authenticates and comes back to the note.
 */
const LOCAL_401_CODES = new Set(["NOTE_SIGNATURE_EXPIRED"]);

/** Two sign-in attempts closer than this are a loop (Keycloak accepted the login but the API still says 401). */
export const LOOP_WINDOW_MS = 60_000;
/** 401s arriving together (one page, many queries) are one episode. */
export const EPISODE_MS = 2_000;

export interface GuardStorage {
  get(): number | null;
  set(ts: number): void;
  clear(): void;
}

/** sessionStorage-backed attempt timestamp (non-secret). Falls back to a no-op when storage is unavailable. */
export function sessionGuardStorage(key = "nais.signin_attempt"): GuardStorage {
  return {
    get() {
      try {
        const v = Number(window.sessionStorage.getItem(key));
        return Number.isFinite(v) && v > 0 ? v : null;
      } catch {
        return null;
      }
    },
    set(ts) {
      try {
        window.sessionStorage.setItem(key, String(ts));
      } catch {
        /* ignore */
      }
    },
    clear() {
      try {
        window.sessionStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

export interface ApiErrorDeps {
  signIn: () => void;
  goBlocked: (code: string) => void;
  pathname: () => string;
  storage: GuardStorage;
  now?: () => number;
  /** Real mode: re-read the session (server refreshes a near-expiry token). Absent in mock mode. */
  refreshSession?: () => Promise<{ accessToken?: string; error?: string } | null>;
  getToken?: () => string | undefined;
  /** Receives the refreshed access token; must install it BEFORE retrying (see applyRefreshedToken). */
  onRefreshed?: (accessToken: string) => void;
}

/**
 * Global reaction to API failures.
 * 401 on a protected path: one session refresh first; sign in only when the token did not change or the refresh failed.
 * A second attempt within LOOP_WINDOW_MS ends at /blocked instead of looping. The guard is never reset by successes
 * (an unrelated 200 during the redirect must not re-arm a loop); it simply expires. Concurrent 401s are one episode.
 * Never acts from /blocked or the auth routes; public pages never force a login.
 */
export function createApiErrorHandler(deps: ApiErrorDeps) {
  const now = deps.now ?? Date.now;
  let episodeAt = -Infinity;

  async function unauthenticated(): Promise<void> {
    const t = now();
    if (t - episodeAt < EPISODE_MS) return;
    episodeAt = t;
    const last = deps.storage.get();
    if (last !== null && t - last < LOOP_WINDOW_MS) {
      deps.goBlocked("UNAUTHENTICATED");
      return;
    }
    if (deps.refreshSession) {
      const before = deps.getToken?.();
      const session = await deps.refreshSession().catch(() => null);
      if (session && !session.error && session.accessToken && session.accessToken !== before) {
        deps.onRefreshed?.(session.accessToken);
        return;
      }
    }
    deps.storage.set(now());
    deps.signIn();
  }

  return {
    onError(error: unknown): void {
      if (!(error instanceof ApiError)) return;
      const path = deps.pathname();
      if (AUTH_PATHS.some((re) => re.test(path))) return;
      if (error.status === 401) {
        if (LOCAL_401_CODES.has(error.code)) return;
        if (isProtected(path)) void unauthenticated();
      } else if (isBlockedCode(error.code)) {
        deps.goBlocked(error.code);
      }
    },
    /** Auth.js flagged RefreshFailed: same guarded sign-in path (protected pages only). */
    onSessionFailed(): void {
      if (isProtected(deps.pathname())) void unauthenticated();
    },
  };
}
