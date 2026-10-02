import pkg from "../../../package.json";

/** The web app's package version, shown in the public footer. Server-only import keeps package.json out of client bundles. */
export const APP_VERSION: string = pkg.version;

/** Support contact for the public footer, set per deployment (NAIS_SUPPORT_CONTACT: an e-mail or a phone line). */
export function supportContact(): string | null {
  return process.env.NAIS_SUPPORT_CONTACT?.trim() || null;
}

/**
 * The operating organisation's site (NAIS_OPERATOR_URL), linked from the public header, hero and footer. Set per
 * deployment, never committed: the repository is public. Anything but an absolute http(s) URL is ignored.
 */
export function operatorUrl(): string | null {
  const raw = process.env.NAIS_OPERATOR_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
