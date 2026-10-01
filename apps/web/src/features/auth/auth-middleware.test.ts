// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authGate } from "./auth-middleware";

const req = (path: string, auth?: { error?: string } | null) =>
  Object.assign(new NextRequest(`http://localhost:3000${path}`, { headers: { host: "localhost:21051" } }), { auth });

describe("real-mode middleware", () => {
  it("redirects protected routes without a session to the Keycloak sign-in", () => {
    const res = authGate(req("/commons/data", null));
    expect(new URL(res.headers.get("x-middleware-rewrite")!).pathname).toBe("/auth-redirect");
    expect(res.headers.get("x-middleware-request-x-nais-login")).toBe("/web-auth/signin");
    expect(decodeURIComponent(res.headers.get("x-middleware-request-x-nais-callback")!)).toBe("/commons/data");
  });
  it("redirects when the session carries an error (RefreshFailed)", () => {
    expect(authGate(req("/settings", { error: "RefreshFailed" })).headers.get("x-middleware-rewrite")).toContain("/auth-redirect");
  });
  it("lets valid sessions and public routes through", () => {
    expect(authGate(req("/commons", {})).headers.get("x-middleware-next")).toBe("1");
    expect(authGate(req("/", null)).headers.get("x-middleware-next")).toBe("1");
  });

  describe("with AUTH_URL set", () => {
    afterEach(() => vi.unstubAllEnvs());
    it("redirects absolutely to the single AUTH_URL origin (no rewrite, no proxy to an external host)", () => {
      vi.stubEnv("AUTH_URL", "http://example.test:21051/web-auth");
      const res = authGate(Object.assign(new NextRequest("http://example.test:21051/commons/data?q=x"), { auth: null }));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("http://example.test:21051/web-auth/signin?callbackUrl=%2Fcommons%2Fdata%3Fq%3Dx");
      expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    });
  });
});
