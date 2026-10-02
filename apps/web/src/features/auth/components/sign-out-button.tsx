"use client";
import { Button } from "@nais/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { isMocking, MOCK_USER_COOKIE } from "@/shared/config";
import { logoutAction } from "../actions";

/** Mock mode drops the mock-user cookie and goes home; otherwise the server action ends the Auth.js and Keycloak sessions. */
export function useSignOut(): () => void {
  const router = useRouter();
  return useCallback(() => {
    if (isMocking()) {
      document.cookie = `${MOCK_USER_COOKIE}=; max-age=0; path=/`;
      router.push("/");
      router.refresh();
    } else {
      void logoutAction();
    }
  }, [router]);
}

export function SignOutButton({ className, label }: { className?: string; label?: string }) {
  const t = useTranslations();
  const signOut = useSignOut();
  const text = label ?? t("auth.signOut");
  if (isMocking()) {
    return (
      <Button variant="ghost" className={className} onClick={signOut}>
        {text}
      </Button>
    );
  }
  return (
    <form action={logoutAction}>
      <Button type="submit" variant="ghost" className={className}>
        {text}
      </Button>
    </form>
  );
}
