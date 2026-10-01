"use client";
import { signIn, useSession } from "next-auth/react";
import { useEffect } from "react";
import { setAccessTokenGetter } from "@/shared/api/client";
import { isMocking } from "@/shared/config";

function useRealAuthReady(): boolean {
  const { data, status } = useSession();
  // Set before children render so their first queries already carry the Bearer token.
  setAccessTokenGetter(() => data?.accessToken);
  useEffect(() => {
    if (data?.error === "RefreshFailed") void signIn("keycloak");
  }, [data?.error]);
  // Sign-out/unmount: the getter must not keep serving the previous user's token (after sign-out `data` is null, so
  // the render-time getter above already returns undefined).
  useEffect(() => () => setAccessTokenGetter(() => undefined), []);
  return status !== "loading";
}

/** true once API calls can be authenticated (always true in mock mode; the cookie identifies the user). */
export const useAuthReady: () => boolean = isMocking() ? () => true : useRealAuthReady;
