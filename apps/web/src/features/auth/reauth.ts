"use client";
import { signIn } from "next-auth/react";
import { isMocking, MOCK_AUTH_TIME_COOKIE } from "@/shared/config";

/** Mock login time (epoch ms), as mock-login records it; the mock API checks it for signatures (5-minute rule). */
export function stampMockAuthTime(now = Date.now()): void {
  document.cookie = `${MOCK_AUTH_TIME_COOKIE}=${now}; path=/; SameSite=Lax`;
}

/**
 * A fresh login for an action that needs one (signing a research note: auth_time within 5 minutes).
 * Real mode: Keycloak login with max_age=0 (asks for the password again even inside the SSO session), then back to
 * `returnTo` — the page reopens what it was doing from its query (e.g. `?sign=1`). Mock mode: the same user's login
 * time is renewed in place, as signing in again on /mock-login would, and the caller retries.
 */
export async function reauthenticate(returnTo: string): Promise<"redirected" | "refreshed"> {
  if (isMocking()) {
    stampMockAuthTime();
    return "refreshed";
  }
  await signIn("keycloak", { redirectTo: returnTo }, { max_age: "0" });
  return "redirected";
}
