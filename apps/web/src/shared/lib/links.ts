/**
 * Returns the in-app path (path + query + hash) of a server-provided link, or null when it is not a same-origin link.
 * Parsed with URL against a base so "/\evil.com", "//evil.com" and absolute URLs cannot escape the origin.
 */
export function safeInternalPath(link: string | null | undefined, base: string = typeof window === "undefined" ? "http://localhost" : window.location.origin): string | null {
  if (!link || !link.startsWith("/")) return null;
  try {
    const origin = new URL(base).origin;
    const url = new URL(link, origin);
    if (url.origin !== origin) return null;
    // "/\evil.com" parses as same-origin on some engines; refuse any backslash or control char before the path proper.
    if (/[\\\u0000-\u001f\u007f]/.test(link)) return null;
    // Dot-segment normalization can turn "/.//evil.com" into "//evil.com", which a browser treats as protocol-relative.
    if (url.pathname.startsWith("//")) return null;
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}
