"use client";
import { useSession } from "next-auth/react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { setAccessTokenGetter } from "@/shared/api/client";
import { isMocking } from "@/shared/config";

/**
 * Feeds the API client the session's access token (memory only). Layout effects run before any child's passive effect,
 * so the first queries of an already-ready subtree carry the Bearer token. Mounted once, in <Providers>.
 */
function useRealAccessTokenBridge(): void {
  const { data } = useSession();
  const tokenRef = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    tokenRef.current = data?.accessToken;
    setAccessTokenGetter(() => tokenRef.current);
  }, [data?.accessToken]);
  // After sign-out `data` is null (token undefined above); on unmount the getter is dropped as well.
  useEffect(() => () => setAccessTokenGetter(() => undefined), []);
}

export const useAccessTokenBridge: () => void = isMocking() ? () => undefined : useRealAccessTokenBridge;

function useRealAuthReady(): boolean {
  return useSession().status !== "loading";
}

/** true once API calls can be authenticated (always true in mock mode; the cookie identifies the user). */
export const useAuthReady: () => boolean = isMocking() ? () => true : useRealAuthReady;
