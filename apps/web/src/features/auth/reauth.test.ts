import { afterEach, describe, expect, it, vi } from "vitest";

const signIn = vi.hoisted(() => vi.fn());
vi.mock("next-auth/react", () => ({ signIn }));

import { MOCK_AUTH_TIME_COOKIE } from "@/shared/config";
import { reauthenticate } from "./reauth";

describe("reauthenticate (fresh login for signing)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    signIn.mockClear();
  });

  it("real mode: forces a Keycloak login (max_age=0) and returns to the given page", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_MOCKING", "disabled");
    expect(await reauthenticate("/commons/notes/n1?sign=1")).toBe("redirected");
    expect(signIn).toHaveBeenCalledExactlyOnceWith("keycloak", { redirectTo: "/commons/notes/n1?sign=1" }, { max_age: "0" });
  });

  it("mock mode: renews the mock login time for the same user, in place", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_MOCKING", "enabled");
    document.cookie = `${MOCK_AUTH_TIME_COOKIE}=1; path=/`;
    const before = Date.now();
    expect(await reauthenticate("/commons/notes/n1?sign=1")).toBe("refreshed");
    const at = Number(/nais_mock_auth_time=(\d+)/.exec(document.cookie)?.[1]);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(signIn).not.toHaveBeenCalled();
  });
});
