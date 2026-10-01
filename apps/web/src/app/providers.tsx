"use client";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionProvider, signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";
import { createApiErrorHandler } from "@/features/auth/on-api-error";
import { useAuthReady } from "@/features/auth/use-auth-ready";
import { makeQueryClient } from "@/shared/api/query-client";
import { isMocking } from "@/shared/config";
import { ToastProvider } from "@/shared/ui/toast";

/** Sets the API token getter from the session and holds children until it is known (no unauthenticated first fetch). */
function ApiAuthBridge({ children }: { children: ReactNode }) {
  const ready = useAuthReady();
  return ready ? <>{children}</> : null;
}

function ApiProviders({ children }: { children: ReactNode }) {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const [client] = useState(() =>
    makeQueryClient({
      onError: createApiErrorHandler({
        pathname: () => window.location.pathname,
        signIn: () => {
          const callback = encodeURIComponent(window.location.pathname + window.location.search);
          if (isMocking()) routerRef.current.push(`/mock-login?callbackUrl=${callback}`);
          else void signIn("keycloak", { callbackUrl: decodeURIComponent(callback) });
        },
        goBlocked: (code) => routerRef.current.push(`/blocked?code=${encodeURIComponent(code)}`),
      }),
    }),
  );
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ApiAuthBridge>{children}</ApiAuthBridge>
      </ToastProvider>
    </QueryClientProvider>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  if (isMocking()) return <ApiProviders>{children}</ApiProviders>;
  return (
    <SessionProvider basePath="/web-auth">
      <ApiProviders>{children}</ApiProviders>
    </SessionProvider>
  );
}
