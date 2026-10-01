import { describe, expect, it } from "vitest";
import { buildEndSessionUrl } from "./logout";

describe("logout", () => {
  it("builds the Keycloak end_session URL from the PUBLIC issuer with id_token_hint and post_logout_redirect_uri", () => {
    const url = new URL(
      buildEndSessionUrl({ issuer: "http://gateway.example:21051/auth/realms/nais", idToken: "ID.TOKEN", postLogoutRedirectUri: "http://gateway.example:21051/" }),
    );
    expect(url.origin + url.pathname).toBe("http://gateway.example:21051/auth/realms/nais/protocol/openid-connect/logout");
    expect(url.searchParams.get("id_token_hint")).toBe("ID.TOKEN");
    expect(url.searchParams.get("post_logout_redirect_uri")).toBe("http://gateway.example:21051/");
  });
});
