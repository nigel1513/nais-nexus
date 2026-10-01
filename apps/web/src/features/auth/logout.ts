/** RP-initiated logout (OIDC): built from the PUBLIC issuer because the browser follows this URL. */
export function buildEndSessionUrl(opts: { issuer: string; idToken: string; postLogoutRedirectUri: string }): string {
  const u = new URL(`${opts.issuer}/protocol/openid-connect/logout`);
  u.searchParams.set("id_token_hint", opts.idToken);
  u.searchParams.set("post_logout_redirect_uri", opts.postLogoutRedirectUri);
  return u.toString();
}
