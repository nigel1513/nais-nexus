import { describe, expect, it } from "vitest";
import { ApiError, asApiError, errorMessageKey, fieldErrors, isBlockedCode, networkError, toApiError } from "./errors";

describe("toApiError", () => {
  it("reads the ErrorEnvelope", () => {
    const e = toApiError(403, { error: { code: "ACCESS_GRANT_REVOKED", message: "revoked", trace_id: "t-1", details: { grant: "g" } } });
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 403, code: "ACCESS_GRANT_REVOKED", message: "revoked", traceId: "t-1", details: { grant: "g" } });
  });

  it("falls back by status when the body is not an envelope (e.g. gateway HTML)", () => {
    expect(toApiError(401, "<html/>").code).toBe("UNAUTHENTICATED");
    expect(toApiError(403, null).code).toBe("FORBIDDEN");
    expect(toApiError(404, {}).code).toBe("NOT_FOUND");
    expect(toApiError(409, {}).code).toBe("CONFLICT");
    expect(toApiError(422, {}).code).toBe("VALIDATION_FAILED");
    expect(toApiError(429, {}).code).toBe("RATE_LIMITED");
    expect(toApiError(500, {}).code).toBe("INTERNAL_ERROR");
    expect(toApiError(502, "<html>Bad Gateway</html>", "req-9")).toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", traceId: "req-9" });
    expect(toApiError(503, {}).code).toBe("DEPENDENCY_UNAVAILABLE");
  });

  it("network failures become DEPENDENCY_UNAVAILABLE with status 0", () => {
    expect(networkError(new TypeError("Failed to fetch"))).toMatchObject({ status: 0, code: "DEPENDENCY_UNAVAILABLE" });
  });

  it("wraps unknown throwables", () => {
    expect(asApiError(new Error("boom")).code).toBe("INTERNAL_ERROR");
    const e = new ApiError(404, "NOT_FOUND", "x", null);
    expect(asApiError(e)).toBe(e);
  });
});

describe("error helpers", () => {
  it("maps known codes to errors.<CODE> and unknown to errors.fallback", () => {
    expect(errorMessageKey("PROJECT_LAST_OWNER")).toBe("errors.PROJECT_LAST_OWNER");
    expect(errorMessageKey("SOMETHING_NEW")).toBe("errors.fallback");
  });

  it("identifies blocked-account codes", () => {
    expect(isBlockedCode("MEMBERSHIP_DISABLED")).toBe(true);
    expect(isBlockedCode("FORBIDDEN")).toBe(false);
  });

  it("extracts field errors from details.fields (object or list form)", () => {
    expect(fieldErrors(new ApiError(422, "VALIDATION_FAILED", "", null, { fields: { name: "too short" } }))).toEqual({ name: "too short" });
    expect(
      fieldErrors(new ApiError(422, "VALIDATION_FAILED", "", null, { fields: [{ field: "end_date", message: "before start" }] })),
    ).toEqual({ end_date: "before start" });
    expect(fieldErrors(new ApiError(422, "VALIDATION_FAILED", "", null))).toEqual({});
  });

  it("normalises indexed keys to the form field and reads the real {field, reason} shape", () => {
    const e = new ApiError(422, "VALIDATION_FAILED", "", null, {
      fields: [
        { field: "keywords.3", reason: "TOO_LONG" },
        { field: "keywords[4]", reason: "later" },
        { field: "members.0.role", reason: "INVALID" },
      ],
    });
    expect(fieldErrors(e)).toEqual({ keywords: "TOO_LONG", members: "INVALID" });
  });
});
