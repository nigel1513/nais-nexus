// @vitest-environment node
import { http, HttpResponse } from "msw";
import type { Account, Session } from "next-auth";
import { describe, expect, it } from "vitest";
import { server } from "../../../tests/msw";
import { jwtCallback, sessionCallback } from "./callbacks";

const tokenUrl = "http://keycloak.test/auth/realms/nais/protocol/openid-connect/token";
const opts = { tokenUrl, clientId: "nais-web", nowMs: 1_000_000_000 };
const NOW_S = 1_000_000;

describe("auth.ts callbacks", () => {
  it("account branch stores access, refresh and id token in the JWT", async () => {
    const out = await jwtCallback({ token: { error: "RefreshFailed" }, account: { access_token: "a", refresh_token: "r", id_token: "i", expires_at: NOW_S + 300 } as Account }, opts);
    expect(out).toMatchObject({ accessToken: "a", refreshToken: "r", idToken: "i", expiresAt: NOW_S + 300, error: undefined });
  });

  it("returns a fresh token untouched (no refresh call)", async () => {
    const token = { accessToken: "a", refreshToken: "r", expiresAt: NOW_S + 200 };
    expect(await jwtCallback({ token }, opts)).toBe(token);
  });

  it("refresh branch exchanges the refresh token at the token endpoint and keeps the id token", async () => {
    let body = "";
    server.use(
      http.post(tokenUrl, async ({ request }) => {
        body = await request.text();
        return HttpResponse.json({ access_token: "a2", expires_in: 300, refresh_token: "r2" });
      }),
    );
    const out = await jwtCallback({ token: { accessToken: "a", refreshToken: "r", idToken: "i", expiresAt: NOW_S + 30 } }, opts);
    expect(body).toBe("grant_type=refresh_token&client_id=nais-web&refresh_token=r");
    expect(out).toMatchObject({ accessToken: "a2", refreshToken: "r2", idToken: "i", expiresAt: NOW_S + 300 });
  });

  it("invalid_grant is sticky: later calls short-circuit without hitting Keycloak", async () => {
    let calls = 0;
    server.use(
      http.post(tokenUrl, () => {
        calls += 1;
        return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
      }),
    );
    const failed = await jwtCallback({ token: { accessToken: "a", refreshToken: "r", idToken: "i", expiresAt: NOW_S - 10 } }, opts);
    expect(failed).toMatchObject({ error: "RefreshFailed" });
    expect(failed.refreshToken).toBeUndefined();
    const again = await jwtCallback({ token: failed }, opts);
    expect(again).toBe(failed);
    expect(calls).toBe(1);
  });

  it("session exposes only accessToken and error", () => {
    const session = sessionCallback({
      session: { user: { name: "x" }, expires: "2099-01-01T00:00:00.000Z" } as Session,
      token: { accessToken: "a", refreshToken: "SECRET-R", idToken: "SECRET-I", expiresAt: 5, error: "RefreshFailed" },
    });
    expect(session).toMatchObject({ accessToken: "a", error: "RefreshFailed" });
    expect(JSON.stringify(session)).not.toMatch(/SECRET/);
  });
});
