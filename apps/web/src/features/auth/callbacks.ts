import type { Account, Session } from "next-auth";
import type { JWT } from "next-auth/jwt";
import { needsRefresh, refreshAccessToken } from "./refresh";

export interface JwtOptions {
  tokenUrl: string;
  clientId: string;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}

export async function jwtCallback({ token, account }: { token: JWT; account?: Account | null }, opts: JwtOptions): Promise<JWT> {
  const nowMs = opts.nowMs ?? Date.now();
  if (account) {
    return {
      ...token,
      accessToken: account.access_token,
      refreshToken: account.refresh_token,
      idToken: account.id_token, // stays in the encrypted cookie; used only as id_token_hint at logout
      expiresAt: account.expires_at ?? Math.floor(nowMs / 1000) + 300,
      error: undefined,
    };
  }
  // A permanently failed session is not retried; only a new sign-in (account branch) clears it.
  if (token.error === "RefreshFailed" && !token.refreshToken) return token;
  if (!needsRefresh(token, nowMs)) return token;
  return refreshAccessToken(token, opts);
}

/** The client session carries the access token and the error flag only (never the refresh or id token). */
export function sessionCallback({ session, token }: { session: Session; token: JWT }): Session {
  session.accessToken = token.accessToken;
  session.error = token.error;
  return session;
}
