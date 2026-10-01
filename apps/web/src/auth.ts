import NextAuth from "next-auth";
import Keycloak from "next-auth/providers/keycloak";
import { jwtCallback, sessionCallback } from "@/features/auth/callbacks";

const issuer = process.env.AUTH_KEYCLOAK_ISSUER ?? "http://localhost:21051/auth/realms/nais";
export const publicIssuer = issuer;
const internal = process.env.AUTH_KEYCLOAK_INTERNAL_URL ?? issuer;
const clientId = process.env.AUTH_KEYCLOAK_ID ?? "nais-web";

/** Discovery is not used: inside the container localhost:21051 is not the gateway (M10 §3.3). */
export const keycloakEndpoints = {
  authorization: `${issuer}/protocol/openid-connect/auth`,
  token: `${internal}/protocol/openid-connect/token`,
  userinfo: `${internal}/protocol/openid-connect/userinfo`,
  jwks: `${internal}/protocol/openid-connect/certs`,
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
    jwt: ({ token, account }) => jwtCallback({ token, account }, { tokenUrl: keycloakEndpoints.token, clientId }),
    session: sessionCallback,
  },
});
