import { afterEach, describe, expect, it, vi } from "vitest";
import { COPYRIGHT, EXTERNAL_LINK, PARENT_SITE_DEFAULT_URL, familySites, httpUrl, parentSite } from "./family-sites";

afterEach(() => vi.unstubAllEnvs());

describe("family sites", () => {
  it("the parent site is 국가과학AI연구센터 on the internal network by default", () => {
    vi.stubEnv("NEXT_PUBLIC_PARENT_SITE_URL", "");
    expect(parentSite()).toEqual({ id: "nais", label: "국가과학AI연구센터", href: "http://192.168.0.3:21050/" });
    expect(PARENT_SITE_DEFAULT_URL).toBe("http://192.168.0.3:21050/");
    expect(familySites()[0]).toEqual(parentSite());
  });

  it("NEXT_PUBLIC_PARENT_SITE_URL overrides it per deployment", () => {
    vi.stubEnv("NEXT_PUBLIC_PARENT_SITE_URL", " https://nais.example.kr ");
    expect(parentSite().href).toBe("https://nais.example.kr/");
  });

  it.each(["javascript:alert(1)", "/relative", "not a url", "ftp://nais.example.kr/"])("ignores %s and keeps the default", (raw) => {
    vi.stubEnv("NEXT_PUBLIC_PARENT_SITE_URL", raw);
    expect(parentSite().href).toBe(PARENT_SITE_DEFAULT_URL);
  });

  it("httpUrl accepts only absolute http(s) URLs", () => {
    expect(httpUrl("http://192.168.0.3:21050")).toBe("http://192.168.0.3:21050/");
    expect(httpUrl(undefined)).toBeNull();
    expect(httpUrl("  ")).toBeNull();
  });

  it("every site has a unique id and a label; links open in a new tab without window.opener", () => {
    const ids = familySites().map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of familySites()) expect(s.label.trim()).not.toBe("");
    expect(EXTERNAL_LINK.target).toBe("_blank");
    expect(EXTERNAL_LINK.rel.split(" ")).toContain("noopener");
    expect(COPYRIGHT).toBe("© 2026 NAIS 국가과학AI연구센터");
  });
});
