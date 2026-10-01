import NextAuth from "next-auth";
import Keycloak from "next-auth/providers/keycloak";
import { needsRefresh, refreshAccessToken } from "@/features/auth/refresh";

const issuer = process.env.AUTH_KEYCLOAK_ISSUER ?? "http://localhost:21051/auth/realms/nais";
const internal = process.env.AUTH_KEYCLOAK_INTERNAL_URL ?? issuer;
const clientId = process.env.AUTH_KEYCLOAK_ID ?? "nais-web";

/** Discovery is not used: inside the container localhost:21051 is not the gateway (M10 §3.3). */
export const keycloakEndpoints = {
  authorization: `${issuer}/protocol/openid-connect/auth`,
  token: `${internal}/protocol/openid-connect/token`,
  userinfo: `${internal}/protocol/openid-connect/userinfo`,
  jwks: `${internal}/protocol/openid-connect/certs`,
  logout: `${internal}/protocol/openid-connect/logout`,
};

export const { handlers, auth, signIn, signOut } = NextAuth({
  basePath: "/web-auth",
  trustHost: true,
  session: { strategy: "jwt" },
  providers: [
    Keycloak({
      issuer, // must equal the token `iss` (public URL)
      clientId,
      client: { token_endpoint_auth_method: "none" }, // public client + PKCE
      authorization: { url: keycloakEndpoints.authorization, params: { scope: "openid profile email" } },
      token: keycloakEndpoints.token,
      userinfo: keycloakEndpoints.userinfo,
      jwks_endpoint: keycloakEndpoints.jwks,
      checks: ["pkce", "state"],
    }),
  ],
  callbacks: {
    async jwt({ token, account }) {
      if (account) {
        return {
          ...token,
          accessToken: account.access_token,
          refreshToken: account.refresh_token,
          expiresAt: account.expires_at ?? Math.floor(Date.now() / 1000) + 300,
          error: undefined,
        };
      }
      if (!needsRefresh(token, Date.now())) return token;
      return refreshAccessToken(token, { tokenUrl: keycloakEndpoints.token, clientId });
    },
    async session({ session, token }) {
      session.accessToken = token.accessToken;
      session.error = token.error;
      return session;
    },
  },
  events: {
    // Back-channel logout: end the Keycloak SSO session with the refresh token (public client), then Auth.js clears its cookie.
    async signOut(message) {
      const refreshToken = "token" in message ? message.token?.refreshToken : undefined;
      if (!refreshToken) return;
      await fetch(keycloakEndpoints.logout, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, refresh_token: refreshToken }),
      }).catch(() => undefined);
    },
  },
});
