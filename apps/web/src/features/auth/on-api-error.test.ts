import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/shared/api/errors";
import { createApiErrorHandler } from "./on-api-error";

const err = (status: number, code: string) => new ApiError(status, code, code, null);
const setup = (path = "/commons") => {
  const deps = { signIn: vi.fn(), goBlocked: vi.fn(), pathname: () => path };
  return { deps, handle: createApiErrorHandler(deps) };
};

describe("global API error handling (Task 4 carry)", () => {
  it("dedupes concurrent 401s into a single signIn", () => {
    const { deps, handle } = setup();
    handle(err(401, "UNAUTHENTICATED"));
    handle(err(401, "UNAUTHENTICATED"));
    expect(deps.signIn).toHaveBeenCalledTimes(1);
  });
  it("never redirects from /blocked or the auth routes", () => {
    for (const p of ["/blocked", "/web-auth/signin", "/mock-login"]) {
      const { deps, handle } = setup(p);
      handle(err(401, "UNAUTHENTICATED"));
      handle(err(403, "USER_DISABLED"));
      expect(deps.signIn).not.toHaveBeenCalled();
      expect(deps.goBlocked).not.toHaveBeenCalled();
    }
  });
  it("sends blocked codes to /blocked?code= and ignores other errors", () => {
    const { deps, handle } = setup();
    handle(err(403, "MEMBERSHIP_DISABLED"));
    handle(err(403, "FORBIDDEN"));
    handle(new Error("x"));
    expect(deps.goBlocked).toHaveBeenCalledExactlyOnceWith("MEMBERSHIP_DISABLED");
    expect(deps.signIn).not.toHaveBeenCalled();
  });
});
