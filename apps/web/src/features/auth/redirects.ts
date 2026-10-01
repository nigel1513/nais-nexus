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

/** Hosts the app may be reached on: those of AUTH_URL and the public Keycloak issuer. Empty = not configured. */
export function allowedHosts(env: Record<string, string | undefined> = process.env): string[] {
  const hosts: string[] = [];
  for (const raw of [env.AUTH_URL, env.AUTH_KEYCLOAK_ISSUER]) {
    try {
      if (raw) hosts.push(new URL(raw).host);
    } catch {
      /* ignore malformed config */
    }
  }
  return hosts;
}

/**
 * Absolute URL on the host the browser used (gateway forwards Host), never the container's 0.0.0.0:3000.
 * A forwarded host that is not in `allowed` (when configured) is ignored: it is client-controlled input.
 */
export function publicUrl(headers: Headers, requestUrl: string, path: string, allowed: string[] = allowedHosts()): URL {
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host || (allowed.length > 0 && !allowed.includes(host))) return new URL(path, requestUrl);
  const proto = headers.get("x-forwarded-proto") ?? new URL(requestUrl).protocol.replace(":", "");
  return new URL(path, `${proto === "https" ? "https" : "http"}://${host}`);
}
