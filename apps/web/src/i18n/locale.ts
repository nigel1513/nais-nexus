export const LOCALES = ["ko", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "ko";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** M10 §12: cookie NEXT_LOCALE → Accept-Language → ko. No URL prefix. */
export function resolveLocale(cookie?: string | null, acceptLanguage?: string | null): Locale {
  if (isLocale(cookie)) return cookie;
  if (acceptLanguage) {
    const ranked = acceptLanguage
      .split(",")
      .map((part, index) => {
        const [tag = "", ...params] = part.trim().split(";");
        const qParam = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
        return { lang: tag.toLowerCase().split("-")[0] ?? "", q: qParam ? Number(qParam.slice(2)) : 1, index };
      })
      .filter((r) => r.lang && Number.isFinite(r.q) && r.q > 0)
      .sort((a, b) => b.q - a.q || a.index - b.index);
    const hit = ranked.find((r) => isLocale(r.lang));
    if (hit) return hit.lang as Locale;
  }
  return DEFAULT_LOCALE;
}
