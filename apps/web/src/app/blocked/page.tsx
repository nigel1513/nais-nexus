import { buttonClass } from "@nais/ui";
import { UserX } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { SignOutButton } from "@/features/auth/components/sign-out-button";
import { isBlockedCode } from "@/shared/api/errors";
import { StatusPage } from "@/shared/ui/status-page";

export default async function BlockedPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code } = await searchParams;
  const t = await getTranslations();
  const known = code && isBlockedCode(code) ? code : null;
  return (
    <StatusPage
      icon={UserX}
      tone="danger"
      code={known ?? undefined}
      title={t("blocked.title")}
      message={<p role="alert">{known ? t(`errors.${known}`) : t("blocked.generic")}</p>}
      help={t("blocked.help")}
      actions={
        <>
          <SignOutButton className={buttonClass("primary")} label={t("blocked.switchAccount")} />
          <Link href="/" className={buttonClass("secondary")}>
            {t("blocked.home")}
          </Link>
        </>
      }
    />
  );
}
