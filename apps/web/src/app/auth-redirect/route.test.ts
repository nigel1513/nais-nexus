// @vitest-environment node
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { GET } from "./route";

const call = (login: string, callback?: string, headers: Record<string, string> = {}) =>
  GET(new NextRequest("http://0.0.0.0:3000/auth-redirect", { headers: { "x-nais-login": login, ...(callback === undefined ? {} : { "x-nais-callback": encodeURIComponent(callback) }), ...headers } }));

describe("auth-redirect", () => {
  it("answers with a relative Location and never reflects a forwarded host", () => {
    const res = call("/mock-login", "/commons/data?q=x", { host: "unlisted.example:9", "x-forwarded-host": "evil.example" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/mock-login?callbackUrl=%2Fcommons%2Fdata%3Fq%3Dx");
  });
  it("only redirects to known sign-in paths and sanitizes the callback", () => {
    expect(call("https://evil.example").status).toBe(400);
    expect(call("//evil.example").status).toBe(400);
    expect(call("/web-auth/signin", "//evil.example").headers.get("location")).toBe("/web-auth/signin?callbackUrl=%2Fcommons");
  });
});
