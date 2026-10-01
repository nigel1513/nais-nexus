import type { JWT } from "next-auth/jwt";

export const REFRESH_MARGIN_S = 60;

export function needsRefresh(token: Pick<JWT, "expiresAt">, nowMs: number): boolean {
  return typeof token.expiresAt === "number" && nowMs / 1000 >= token.expiresAt - REFRESH_MARGIN_S;
}

/** Keycloak refresh_token grant against the INTERNAL token endpoint (the web container cannot reach localhost:21051). */
export async function refreshAccessToken(
  token: JWT,
  opts: { tokenUrl: string; clientId: string; fetchImpl?: typeof fetch; nowMs?: number },
): Promise<JWT> {
  if (!token.refreshToken) return { ...token, error: "RefreshFailed" };
  try {
    const res = await (opts.fetchImpl ?? fetch)(opts.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: opts.clientId, refresh_token: token.refreshToken }),
    });
    if (!res.ok) return { ...token, error: "RefreshFailed" };
    const body = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string };
    const now = Math.floor((opts.nowMs ?? Date.now()) / 1000);
    return {
      ...token,
      accessToken: body.access_token,
      expiresAt: now + body.expires_in,
      refreshToken: body.refresh_token ?? token.refreshToken,
      error: undefined,
    };
  } catch {
    return { ...token, error: "RefreshFailed" };
  }
}
