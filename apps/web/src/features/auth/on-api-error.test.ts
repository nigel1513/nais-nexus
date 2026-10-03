import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/shared/api/errors";
import { createApiErrorHandler, EPISODE_MS, LOOP_WINDOW_MS, type GuardStorage } from "./on-api-error";

const err = (status: number, code: string) => new ApiError(status, code, code, null);
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(path = "/commons", extra: Partial<Parameters<typeof createApiErrorHandler>[0]> = {}) {
  let stored: number | null = null;
  let t = 1_000_000;
  const storage: GuardStorage = { get: () => stored, set: (v) => (stored = v), clear: () => (stored = null) };
  const deps = { signIn: vi.fn(), goBlocked: vi.fn(), pathname: () => path, storage, now: () => t, ...extra };
  return { deps, h: createApiErrorHandler(deps), advance: (ms: number) => (t += ms), storage };
}

describe("global API error handling (Task 4 carry)", () => {
  it("a normal single 401 signs in once; concurrent 401s are one episode", async () => {
    const { deps, h } = setup();
    h.onError(err(401, "UNAUTHENTICATED"));
    h.onError(err(401, "UNAUTHENTICATED"));
    await flush();
    expect(deps.signIn).toHaveBeenCalledTimes(1);
    expect(deps.goBlocked).not.toHaveBeenCalled();
  });

  it("a persistent-401 loop ends at /blocked instead of signing in again", async () => {
    const { deps, h, advance } = setup();
    h.onError(err(401, "UNAUTHENTICATED"));
    await flush();
    advance(EPISODE_MS + 5_000); // back from Keycloak, still 401
    h.onError(err(401, "UNAUTHENTICATED"));
    await flush();
    expect(deps.signIn).toHaveBeenCalledTimes(1);
    expect(deps.goBlocked).toHaveBeenCalledExactlyOnceWith("UNAUTHENTICATED");
  });

  it("an unrelated success during the redirect does not re-arm the loop (no reset on success)", async () => {
    const { deps, h, advance } = setup();
    h.onError(err(401, "UNAUTHENTICATED"));
    await flush();
    expect(deps.signIn).toHaveBeenCalledTimes(1);
    advance(EPISODE_MS + 1_000); // a public endpoint answered 200 meanwhile: nothing to call, nothing is cleared
    h.onError(err(401, "UNAUTHENTICATED"));
    await flush();
    expect(deps.signIn).toHaveBeenCalledTimes(1);
    expect(deps.goBlocked).toHaveBeenCalledExactlyOnceWith("UNAUTHENTICATED");
  });

  it("the guard expires after the window", async () => {
    const b = setup();
    b.h.onError(err(401, "UNAUTHENTICATED"));
    await flush();
    b.advance(LOOP_WINDOW_MS + 1);
    b.h.onError(err(401, "UNAUTHENTICATED"));
    await flush();
    expect(b.deps.signIn).toHaveBeenCalledTimes(2);
    expect(b.deps.goBlocked).not.toHaveBeenCalled();
  });

  it("tries one session refresh first and signs in only if the token did not change", async () => {
    const refreshed = setup("/commons", { getToken: () => "old", refreshSession: vi.fn().mockResolvedValue({ accessToken: "new" }), onRefreshed: vi.fn() });
    refreshed.h.onError(err(401, "UNAUTHENTICATED"));
    await flush();
    expect(refreshed.deps.onRefreshed).toHaveBeenCalledWith("new");
    expect(refreshed.deps.signIn).not.toHaveBeenCalled();

    const same = setup("/commons", { getToken: () => "old", refreshSession: vi.fn().mockResolvedValue({ accessToken: "old" }) });
    same.h.onError(err(401, "UNAUTHENTICATED"));
    await flush();
    expect(same.deps.signIn).toHaveBeenCalledTimes(1);

    const failed = setup("/commons", { getToken: () => "old", refreshSession: vi.fn().mockResolvedValue({ accessToken: "new", error: "RefreshFailed" }) });
    failed.h.onError(err(401, "UNAUTHENTICATED"));
    await flush();
    expect(failed.deps.signIn).toHaveBeenCalledTimes(1);
  });

  it("never acts from /blocked or the auth routes, and never forces login on public pages", async () => {
    for (const p of ["/blocked", "/web-auth/signin", "/mock-login", "/", "/pricing"]) {
      const { deps, h } = setup(p);
      h.onError(err(401, "UNAUTHENTICATED"));
      h.onSessionFailed();
      if (["/blocked", "/web-auth/signin", "/mock-login"].includes(p)) h.onError(err(403, "USER_DISABLED"));
      await flush();
      expect(deps.signIn).not.toHaveBeenCalled();
      expect(deps.goBlocked).not.toHaveBeenCalled();
    }
  });

  it("sends blocked codes to /blocked?code= and ignores other errors", () => {
    const { deps, h } = setup();
    h.onError(err(403, "MEMBERSHIP_DISABLED"));
    h.onError(err(403, "FORBIDDEN"));
    h.onError(new Error("x"));
    expect(deps.goBlocked).toHaveBeenCalledExactlyOnceWith("MEMBERSHIP_DISABLED");
    expect(deps.signIn).not.toHaveBeenCalled();
  });

  it("RefreshFailed on a protected page uses the same guarded sign-in", async () => {
    const { deps, h } = setup();
    h.onSessionFailed();
    await flush();
    expect(deps.signIn).toHaveBeenCalledTimes(1);
  });

  it("leaves 401 NOTE_SIGNATURE_EXPIRED to the sign dialog: no refresh, no sign-in, no /blocked", async () => {
    const refreshSession = vi.fn().mockResolvedValue({ accessToken: "new" });
    const { deps, h } = setup("/commons/notes/n1", { getToken: () => "old", refreshSession });
    h.onError(err(401, "NOTE_SIGNATURE_EXPIRED"));
    h.onError(err(401, "NOTE_SIGNATURE_EXPIRED"));
    await flush();
    expect(refreshSession).not.toHaveBeenCalled();
    expect(deps.signIn).not.toHaveBeenCalled();
    expect(deps.goBlocked).not.toHaveBeenCalled();
    // An ordinary 401 right after still takes the global path.
    h.onError(err(401, "UNAUTHENTICATED"));
    await flush();
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });
});
