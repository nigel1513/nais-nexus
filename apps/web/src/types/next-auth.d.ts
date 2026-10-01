import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    /** Exposed to the client for the Bearer header. The refresh token never leaves the encrypted cookie. */
    accessToken?: string;
    error?: "RefreshFailed";
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string;
    refreshToken?: string;
    /** Server-side cookie only: id_token_hint for the Keycloak end_session redirect. */
    idToken?: string;
    expiresAt?: number;
    error?: "RefreshFailed";
  }
}
