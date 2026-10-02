import pkg from "../../../package.json";

/** The web app's package version, shown in the public footer. Server-only import keeps package.json out of client bundles. */
export const APP_VERSION: string = pkg.version;

/** Support contact for the public footer, set per deployment (NAIS_SUPPORT_CONTACT: an e-mail or a phone line). */
export function supportContact(): string | null {
  return process.env.NAIS_SUPPORT_CONTACT?.trim() || null;
}
