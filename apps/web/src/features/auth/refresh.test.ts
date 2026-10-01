import { describe, expect, it, vi } from "vitest";
import { needsRefresh, refreshAccessToken } from "./refresh";

const opts = { tokenUrl: "http://keycloak:8080/auth/realms/nais/protocol/openid-connect/token", clientId: "nais-web" };

describe("token refresh (M10 §3.4)", () => {
  it("refreshes 60s before expiry", () => {
    expect(needsRefresh({ expiresAt: 1000 }, 939_000)).toBe(false);
    expect(needsRefresh({ expiresAt: 1000 }, 940_000)).toBe(true);
    expect(needsRefresh({}, 0)).toBe(false);
  });

  it("exchanges the refresh token at the internal token endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: "new", expires_in: 300, refresh_token: "r2" }), { status: 200 }));
    const out = await refreshAccessToken({ accessToken: "old", refreshToken: "r1", expiresAt: 1 }, { ...opts, fetchImpl, nowMs: 10_000 });
    expect(out).toMatchObject({ accessToken: "new", refreshToken: "r2", expiresAt: 310 });
    expect(out.error).toBeUndefined();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(opts.tokenUrl);
    expect(String(init.body)).toBe("grant_type=refresh_token&client_id=nais-web&refresh_token=r1");
  });

  it("flags RefreshFailed on HTTP error, network error or missing refresh token", async () => {
    const bad = vi.fn().mockResolvedValue(new Response("{}", { status: 400 }));
    expect((await refreshAccessToken({ refreshToken: "r" }, { ...opts, fetchImpl: bad })).error).toBe("RefreshFailed");
    const down = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    expect((await refreshAccessToken({ refreshToken: "r" }, { ...opts, fetchImpl: down })).error).toBe("RefreshFailed");
    expect((await refreshAccessToken({}, opts)).error).toBe("RefreshFailed");
  });

  it("drops the refresh token on invalid_grant and does not keep it for retries", async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    const out = await refreshAccessToken({ accessToken: "a", refreshToken: "r", expiresAt: 1 }, { ...opts, fetchImpl: f });
    expect(out.error).toBe("RefreshFailed");
    expect(out.refreshToken).toBeUndefined();
  });

  it("a transient failure keeps the refresh token and does not flag a still-valid token", async () => {
    const down = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const out = await refreshAccessToken({ accessToken: "a", refreshToken: "r", expiresAt: 400 }, { ...opts, fetchImpl: down, nowMs: 350_000 });
    expect(out.error).toBeUndefined();
    expect(out.refreshToken).toBe("r");
    const expired = await refreshAccessToken({ accessToken: "a", refreshToken: "r", expiresAt: 100 }, { ...opts, fetchImpl: down, nowMs: 350_000 });
    expect(expired).toMatchObject({ error: "RefreshFailed", refreshToken: "r" });
  });
});
