const PROTECTED = [/^\/commons(\/|$)/, /^\/settings(\/|$)/];

export function isProtected(pathname: string): boolean {
  return PROTECTED.some((re) => re.test(pathname));
}

/** Only same-origin relative paths are allowed as post-login destinations (no open redirect). */
export function safeCallbackUrl(raw: string | null | undefined, fallback = "/commons"): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  try {
    const u = new URL(raw, "http://placeholder.invalid");
    if (u.origin !== "http://placeholder.invalid") return fallback;
    return u.pathname + u.search + u.hash;
  } catch {
    return fallback;
  }
}

/** Absolute URL on the host the browser used (gateway forwards Host), never the container's 0.0.0.0:3000. */
export function publicUrl(headers: Headers, requestUrl: string, path: string): URL {
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host) return new URL(path, requestUrl);
  const proto = headers.get("x-forwarded-proto") ?? new URL(requestUrl).protocol.replace(":", "");
  return new URL(path, `${proto}://${host}`);
}
