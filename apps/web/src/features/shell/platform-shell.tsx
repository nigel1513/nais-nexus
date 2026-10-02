"use client";
import { signIn } from "next-auth/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAuthReady } from "@/features/auth/use-auth-ready";
import { asApiError, isBlockedCode } from "@/shared/api/errors";
import { isMocking } from "@/shared/config";
import { useMe } from "@/shared/hooks/use-me";
import { AppShell, AppShellFrame } from "@/shared/ui/app-shell";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";

/** Loads getMe once (`frame` wraps the loading and error views, e.g. in the empty shell); blocked accounts go to /blocked, signed-out users to login (M10 §3.4, §6). */
export function MeGate({ children, frame = (c) => c }: { children: ReactNode; frame?: (content: ReactNode) => ReactNode }) {
  const ready = useAuthReady();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const me = useMe(ready);
  const code = me.error ? asApiError(me.error).code : null;
  const redirecting = !!code && (isBlockedCode(code) || code === "UNAUTHENTICATED");

  useEffect(() => {
    if (!code) return;
    if (isBlockedCode(code)) {
      router.replace(`/blocked?code=${code}`);
    } else if (code === "UNAUTHENTICATED") {
      const qs = search.toString();
      const callbackUrl = pathname + (qs ? `?${qs}` : "");
      if (isMocking()) router.replace(`/mock-login?callbackUrl=${encodeURIComponent(callbackUrl)}`);
      else void signIn("keycloak", { redirectTo: callbackUrl });
    }
  }, [code, pathname, router, search]);

  if (!ready || me.isPending || redirecting) return frame(<DelayedSkeleton lines={4} />);
  if (me.isError && !me.data) return frame(<ErrorView error={me.error} onRetry={() => void me.refetch()} />);
  return <>{children}</>;
}

function Frame({ children }: { children: ReactNode }) {
  const { data } = useMe();
  return <AppShell me={data!}>{children}</AppShell>;
}

export function PlatformShell({ children }: { children: ReactNode }) {
  return (
    <MeGate frame={(content) => <AppShellFrame>{content}</AppShellFrame>}>
      <Frame>{children}</Frame>
    </MeGate>
  );
}
