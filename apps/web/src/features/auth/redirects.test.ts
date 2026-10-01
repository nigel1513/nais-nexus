import { describe, expect, it } from "vitest";
import { allowedHosts, isProtected, publicUrl, safeCallbackUrl } from "./redirects";

describe("redirect helpers", () => {
  it("protects /commons and /settings only", () => {
    expect(isProtected("/commons")).toBe(true);
    expect(isProtected("/commons/data/1")).toBe(true);
    expect(isProtected("/settings/organization")).toBe(true);
    expect(isProtected("/")).toBe(false);
    expect(isProtected("/commonsx")).toBe(false);
    expect(isProtected("/blocked")).toBe(false);
  });

  it("keeps same-origin relative callback URLs", () => {
    expect(safeCallbackUrl("/commons/data?q=battery#top")).toBe("/commons/data?q=battery#top");
  });

  it("rejects open redirects", () => {
    for (const raw of ["//evil.example", "https://evil.example/x", "/\\evil.example", "javascript:alert(1)", "commons", "", null, undefined]) {
      expect(safeCallbackUrl(raw)).toBe("/commons");
    }
  });

  it("builds redirect URLs from the Host the gateway forwarded", () => {
    const headers = new Headers({ host: "gateway.example:21051" });
    expect(publicUrl(headers, "http://0.0.0.0:3000/commons", "/mock-login").toString()).toBe("http://gateway.example:21051/mock-login");
    expect(publicUrl(new Headers(), "http://localhost:3000/x", "/y").toString()).toBe("http://localhost:3000/y");
  });

  it("ignores a forwarded host outside AUTH_URL / issuer hosts", () => {
    const allowed = allowedHosts({ AUTH_URL: "http://gateway.example:21051/web-auth", AUTH_KEYCLOAK_ISSUER: "http://localhost:21051/auth/realms/nais" });
    expect(allowed).toEqual(["gateway.example:21051", "localhost:21051"]);
    const evil = new Headers({ "x-forwarded-host": "evil.example" });
    expect(publicUrl(evil, "http://0.0.0.0:3000/commons", "/mock-login", allowed).toString()).toBe("http://0.0.0.0:3000/mock-login");
    const ok = new Headers({ "x-forwarded-host": "localhost:21051" });
    expect(publicUrl(ok, "http://0.0.0.0:3000/commons", "/mock-login", allowed).toString()).toBe("http://localhost:21051/mock-login");
  });
});
