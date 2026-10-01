// @vitest-environment node
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { mockMiddleware } from "./mock-middleware";

/** path + query of the internal rewrite target (host-independent). */
const rewriteOf = (res: Response) => {
  const u = new URL(res.headers.get("x-middleware-rewrite")!);
  return u.pathname + "|" + res.headers.get("x-middleware-request-x-nais-login") + "|" + decodeURIComponent(res.headers.get("x-middleware-request-x-nais-callback")!);
};

describe("mock-mode middleware", () => {
  it("redirects protected routes without a mock session to /mock-login with a callback", () => {
    const res = mockMiddleware(new NextRequest("http://localhost:3000/commons/data?q=x", { headers: { host: "localhost:21051" } }));
    expect(rewriteOf(res)).toBe("/auth-redirect|/mock-login|/commons/data?q=x");
  });

  it("lets requests with a mock session through", () => {
    const res = mockMiddleware(
      new NextRequest("http://localhost:3000/commons", { headers: { host: "localhost:21051", cookie: "nais_mock_user=00000000-0000-7000-8000-000000000a02" } }),
    );
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("ignores public routes", () => {
    const res = mockMiddleware(new NextRequest("http://localhost:3000/", { headers: { host: "localhost:21051" } }));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("never reflects an unlisted or spoofed host into Location", () => {
    const res = mockMiddleware(new NextRequest("http://0.0.0.0:3000/commons", { headers: { host: "unlisted.example:9", "x-forwarded-host": "evil.example" } }));
    expect(rewriteOf(res)).toBe("/auth-redirect|/mock-login|/commons");
    expect(res.headers.get("x-middleware-rewrite")).not.toContain("evil.example");
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirects relative so it works on the external host the browser used", () => {
    vi.stubEnv("NAIS_EXTERNAL_HOST", "example-external-host");
    try {
      const res = mockMiddleware(new NextRequest("http://0.0.0.0:3000/commons", { headers: { host: "example-external-host:21051" } }));
      expect(rewriteOf(res)).toBe("/auth-redirect|/mock-login|/commons");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
