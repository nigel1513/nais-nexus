import { afterEach, describe, expect, it, vi } from "vitest";
import { apiBase, isMocking, LOCALE_COOKIE, MOCK_USER_COOKIE } from "./config";

afterEach(() => vi.unstubAllEnvs());

describe("config", () => {
  it("mock mode routes the client to the in-app mock API", () => {
    vi.stubEnv("NEXT_PUBLIC_API_MOCKING", "enabled");
    expect(isMocking()).toBe(true);
    expect(apiBase()).toBe("/mock-api/v1");
  });

  it("real mode uses NEXT_PUBLIC_API_BASE, defaulting to /api/v1", () => {
    vi.stubEnv("NEXT_PUBLIC_API_MOCKING", "disabled");
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "");
    expect(isMocking()).toBe(false);
    expect(apiBase()).toBe("/api/v1");
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "/api/v1");
    expect(apiBase()).toBe("/api/v1");
  });

  it("anything other than 'enabled' is not mock mode", () => {
    vi.stubEnv("NEXT_PUBLIC_API_MOCKING", "true");
    expect(isMocking()).toBe(false);
  });

  it("exposes cookie names", () => {
    expect(MOCK_USER_COOKIE).toBe("nais_mock_user");
    expect(LOCALE_COOKIE).toBe("NEXT_LOCALE");
  });
});
