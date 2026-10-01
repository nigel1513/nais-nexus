"use client";
import { Button } from "@nais/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { isMocking, MOCK_USER_COOKIE } from "@/shared/config";
import { logoutAction } from "../actions";

export function SignOutButton({ className, label }: { className?: string; label?: string }) {
  const t = useTranslations();
  const router = useRouter();
  const text = label ?? t("auth.signOut");
  if (isMocking()) {
    return (
      <Button
        variant="ghost"
        className={className}
        onClick={() => {
          document.cookie = `${MOCK_USER_COOKIE}=; max-age=0; path=/`;
          router.push("/");
          router.refresh();
        }}
      >
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
