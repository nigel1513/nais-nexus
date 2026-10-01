import { describe, expect, it } from "vitest";
import { resolveLocale } from "./locale";

describe("resolveLocale (cookie NEXT_LOCALE → Accept-Language → ko)", () => {
  it("cookie wins", () => expect(resolveLocale("en", "ko-KR,ko;q=0.9")).toBe("en"));
  it("ignores an unknown cookie value", () => expect(resolveLocale("fr", "en-US,en;q=0.9")).toBe("en"));
  it("uses the highest-q supported language", () => expect(resolveLocale(undefined, "fr;q=1, en;q=0.8, ko;q=0.9")).toBe("ko"));
  it("defaults to ko", () => {
    expect(resolveLocale(undefined, undefined)).toBe("ko");
    expect(resolveLocale(null, "de-DE")).toBe("ko");
    expect(resolveLocale(null, "garbage;;;q=x")).toBe("ko");
  });
});
