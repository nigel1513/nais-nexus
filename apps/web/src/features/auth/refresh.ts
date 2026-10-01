import type { JWT } from "next-auth/jwt";

export const REFRESH_MARGIN_S = 60;

export function needsRefresh(token: Pick<JWT, "expiresAt">, nowMs: number): boolean {
  return typeof token.expiresAt === "number" && nowMs / 1000 >= token.expiresAt - REFRESH_MARGIN_S;
}

/** Permanent failure: the refresh token is dropped so nothing retries it (sticky until a new sign-in). */
function permanentFailure(token: JWT): JWT {
  const next: JWT = { ...token, error: "RefreshFailed" };
  delete next.refreshToken;
  return next;
}

/**
 * Keycloak refresh_token grant against the INTERNAL token endpoint (the web container cannot reach localhost:21051).
 * invalid_grant (and a missing refresh token) is permanent. Other failures keep the refresh token for a later retry and
 * only flag the session once the access token is actually expired.
 */
export async function refreshAccessToken(
  token: JWT,
  opts: { tokenUrl: string; clientId: string; fetchImpl?: typeof fetch; nowMs?: number },
): Promise<JWT> {
  if (!token.refreshToken) return { ...token, error: "RefreshFailed" };
  const nowMs = opts.nowMs ?? Date.now();
  const transient = (): JWT => (typeof token.expiresAt === "number" && token.expiresAt * 1000 > nowMs ? token : { ...token, error: "RefreshFailed" });
  try {
    const res = await (opts.fetchImpl ?? fetch)(opts.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: opts.clientId, refresh_token: token.refreshToken }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return body.error === "invalid_grant" || res.status === 400 || res.status === 401 ? permanentFailure(token) : transient();
    }
    const body = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string; id_token?: string };
    const now = Math.floor(nowMs / 1000);
    return {
      ...token,
      accessToken: body.access_token,
      expiresAt: now + body.expires_in,
      refreshToken: body.refresh_token ?? token.refreshToken,
      idToken: body.id_token ?? token.idToken,
      error: undefined,
    };
  } catch {
    return transient();
  }
}
