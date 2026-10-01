// @vitest-environment node
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { mockMiddleware } from "./mock-middleware";

describe("mock-mode middleware", () => {
  it("redirects protected routes without a mock session to /mock-login with a callback", () => {
    const res = mockMiddleware(new NextRequest("http://localhost:3000/commons/data?q=x", { headers: { host: "localhost:21051" } }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/mock-login?callbackUrl=%2Fcommons%2Fdata%3Fq%3Dx");
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
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/mock-login?callbackUrl=%2Fcommons");
    expect(res.headers.get("location")).not.toContain("evil.example");
  });

  it("redirects relative so it works on the external host the browser used", () => {
    vi.stubEnv("NAIS_EXTERNAL_HOST", "example-external-host");
    try {
      const res = mockMiddleware(new NextRequest("http://0.0.0.0:3000/commons", { headers: { host: "example-external-host:21051" } }));
      expect(res.headers.get("location")).toBe("/mock-login?callbackUrl=%2Fcommons");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
