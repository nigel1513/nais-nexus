/**
 * Family sites: the parent organisation and its other services, linked from the public footer and the sidebar.
 * Add a site by adding an entry to FAMILY_SITES; the first entry is the parent ("<label> 홈 ↗" in the sidebar).
 *
 * NEXT_PUBLIC_* values are inlined at build time, so each entry reads its variable by its literal name.
 */
export type FamilySite = { id: string; label: string; href: string };

type FamilySiteConfig = {
  id: string;
  /** Proper name, shown as is in every locale. */
  label: string;
  /** Per-deployment override (an absolute http(s) URL); anything else falls back to `fallback`. */
  env: () => string | undefined;
  fallback: string;
};

/** Default parent site: the NAIS site on the internal network (a private LAN address, safe to commit). */
export const PARENT_SITE_DEFAULT_URL = "http://192.168.0.3:21050/";
export const PARENT_SITE_LABEL = "국가과학AI연구센터";

const FAMILY_SITES: readonly FamilySiteConfig[] = [
  { id: "nais", label: PARENT_SITE_LABEL, env: () => process.env.NEXT_PUBLIC_PARENT_SITE_URL, fallback: PARENT_SITE_DEFAULT_URL },
];

/** An absolute http(s) URL, normalised; null for anything else (relative paths, javascript:, typos). */
export function httpUrl(raw: string | undefined | null): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function familySites(): FamilySite[] {
  return FAMILY_SITES.map(({ id, label, env, fallback }) => ({ id, label, href: httpUrl(env()) ?? fallback }));
}

/** The parent organisation's site (the first family site). */
export function parentSite(): FamilySite {
  return familySites()[0]!;
}

/** Shown in the public footer and the sidebar. */
export const COPYRIGHT = "© 2026 NAIS 국가과학AI연구센터";

/** Every family link leaves the portal in a new tab without handing it window.opener. */
export const EXTERNAL_LINK = { target: "_blank", rel: "noopener noreferrer" } as const;
