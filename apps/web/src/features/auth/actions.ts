"use server";
import { getToken } from "next-auth/jwt";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { signOut } from "@/auth";
import { buildEndSessionUrl } from "./logout";
import { publicUrl } from "./redirects";

/** Clears the Auth.js session, then ends the Keycloak SSO session (id_token_hint) and returns to "/". */
export async function logoutAction(): Promise<void> {
  const h = await headers();
  const secret = process.env.AUTH_SECRET;
  const secureCookie = (process.env.AUTH_URL ?? "").startsWith("https:");
  const token = secret ? await getToken({ req: { headers: h }, secret, secureCookie }).catch(() => null) : null;
  await signOut({ redirect: false });
  const issuer = process.env.AUTH_KEYCLOAK_ISSUER;
  if (!token?.idToken || !issuer) redirect("/");
  const home = publicUrl(h, "http://localhost:3000/", "/").toString();
  redirect(buildEndSessionUrl({ issuer, idToken: token.idToken, postLogoutRedirectUri: home }));
}
