"use client";
import { QueryClientProvider } from "@tanstack/react-query";
import { getSession, SessionProvider, signIn, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createApiErrorHandler, sessionGuardStorage } from "@/features/auth/on-api-error";
import { applyRefreshedToken } from "@/features/auth/refresh-session";
import { useAccessTokenBridge } from "@/features/auth/use-auth-ready";
import { makeQueryClient } from "@/shared/api/query-client";
import { getAccessToken } from "@/shared/api/client";
import { isMocking } from "@/shared/config";
import { ToastProvider } from "@/shared/ui/toast";

type Handler = ReturnType<typeof createApiErrorHandler>;

function SessionWatcher({ handler }: { handler: Handler }) {
  const { data } = useSession();
  useEffect(() => {
    if (data?.error === "RefreshFailed") handler.onSessionFailed();
  }, [data?.error, handler]);
  return null;
}

function ApiProviders({ children }: { children: ReactNode }) {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  useAccessTokenBridge();
  const [{ client, handler }] = useState(() => {
    const holder: { client?: ReturnType<typeof makeQueryClient> } = {};
    const handler = createApiErrorHandler({
      pathname: () => window.location.pathname,
      storage: sessionGuardStorage(),
      getToken: getAccessToken,
      refreshSession: isMocking() ? undefined : async () => {
        const s = await getSession();
        return s ? { accessToken: s.accessToken, error: s.error } : null;
      },
      onRefreshed: (token) => void (holder.client && applyRefreshedToken(holder.client, token)),
      signIn: () => {
        const callbackUrl = window.location.pathname + window.location.search;
        if (isMocking()) routerRef.current.push(`/mock-login?callbackUrl=${encodeURIComponent(callbackUrl)}`);
        else void signIn("keycloak", { callbackUrl });
      },
      goBlocked: (code) => routerRef.current.push(`/blocked?code=${encodeURIComponent(code)}`),
    });
    holder.client = makeQueryClient({ onError: handler.onError });
    return { client: holder.client, handler };
  });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        {isMocking() ? null : <SessionWatcher handler={handler} />}
        {children}
      </ToastProvider>
    </QueryClientProvider>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  if (isMocking()) return <ApiProviders>{children}</ApiProviders>;
  // The access token lives 300 s and is refreshed 60 s early: poll the session so it is renewed before it expires.
  return (
    <SessionProvider basePath="/web-auth" refetchInterval={120}>
      <ApiProviders>{children}</ApiProviders>
    </SessionProvider>
  );
}
