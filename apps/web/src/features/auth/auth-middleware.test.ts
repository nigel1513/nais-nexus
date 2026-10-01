// @vitest-environment node
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { authGate } from "./auth-middleware";

const req = (path: string, auth?: { error?: string } | null) =>
  Object.assign(new NextRequest(`http://localhost:3000${path}`, { headers: { host: "localhost:21051" } }), { auth });

describe("real-mode middleware", () => {
  it("redirects protected routes without a session to the Keycloak sign-in", () => {
    const res = authGate(req("/commons/data", null));
    expect(res.headers.get("location")).toBe("/web-auth/signin?callbackUrl=%2Fcommons%2Fdata");
  });
  it("redirects when the session carries an error (RefreshFailed)", () => {
    expect(authGate(req("/settings", { error: "RefreshFailed" })).status).toBe(307);
  });
  it("lets valid sessions and public routes through", () => {
    expect(authGate(req("/commons", {})).headers.get("x-middleware-next")).toBe("1");
    expect(authGate(req("/", null)).headers.get("x-middleware-next")).toBe("1");
  });
});
