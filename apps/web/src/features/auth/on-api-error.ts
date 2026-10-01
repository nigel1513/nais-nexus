import { ApiError, isBlockedCode } from "@/shared/api/errors";

const AUTH_PATHS = [/^\/blocked(\/|$)/, /^\/web-auth(\/|$)/, /^\/mock-login(\/|$)/];

export interface ApiErrorDeps {
  signIn: () => void;
  goBlocked: (code: string) => void;
  pathname: () => string;
}

/**
 * Global reaction to API failures. 401 -> one sign-in (concurrent 401s are deduped; the session refresh itself
 * happens in the Auth.js jwt callback). Blocked codes -> /blocked?code=. Never acts from /blocked or the auth routes,
 * so there is no redirect loop.
 */
export function createApiErrorHandler(deps: ApiErrorDeps): (error: unknown) => void {
  let signingIn = false;
  return (error) => {
    if (!(error instanceof ApiError)) return;
    if (AUTH_PATHS.some((re) => re.test(deps.pathname()))) return;
    if (error.status === 401) {
      if (signingIn) return;
      signingIn = true;
      deps.signIn();
    } else if (isBlockedCode(error.code)) {
      deps.goBlocked(error.code);
    }
  };
}
