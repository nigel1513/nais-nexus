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

/**
 * Hosts the app may be reached on: AUTH_URL and the public issuer (host:port), NAIS_EXTERNAL_HOST (host name or IP, any
 * port: the port comes from the request) and the optional comma-separated AUTH_ALLOWED_HOSTS. Empty = not configured.
 */
export function allowedHosts(env: Record<string, string | undefined> = process.env): string[] {
  const hosts: string[] = [];
  for (const raw of [env.AUTH_URL, env.AUTH_KEYCLOAK_ISSUER]) {
    try {
      if (raw) hosts.push(new URL(raw).host);
    } catch {
      /* ignore malformed config */
    }
  }
  for (const raw of [env.NAIS_EXTERNAL_HOST, ...(env.AUTH_ALLOWED_HOSTS ?? "").split(",")]) {
    const h = raw?.trim();
    if (h) hosts.push(h);
  }
  return hosts;
}

/** An entry with a port must match exactly; an entry without one matches that host name on any port. */
function hostAllowed(host: string, allowed: string[]): boolean {
  const name = host.replace(/:\d+$/, "");
  return allowed.some((entry) => entry === host || (!/:\d+$/.test(entry) && entry === name));
}

/**
 * Absolute URL on the host the browser used (gateway forwards Host), never the container's 0.0.0.0:3000.
 * A forwarded host that is not allowed (when configured) is ignored: it is client-controlled input.
 */
export function publicUrl(headers: Headers, requestUrl: string, path: string, allowed: string[] = allowedHosts()): URL {
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host || (allowed.length > 0 && !hostAllowed(host, allowed))) return new URL(path, requestUrl);
  const proto = headers.get("x-forwarded-proto") ?? new URL(requestUrl).protocol.replace(":", "");
  return new URL(path, `${proto === "https" ? "https" : "http"}://${host}`);
}

/** Request protocol as the browser saw it (gateway forwards x-forwarded-proto); falls back to the configured URL. */
export function isSecureRequest(headers: Headers, fallbackUrl: string): boolean {
  const proto = headers.get("x-forwarded-proto") ?? new URL(fallbackUrl).protocol.replace(":", "");
  return proto.split(",")[0]!.trim() === "https";
}
