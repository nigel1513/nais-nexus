import { buttonClass } from "@nais/ui";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { SignOutButton } from "@/features/auth/components/sign-out-button";
import { isBlockedCode } from "@/shared/api/errors";

export default async function BlockedPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code } = await searchParams;
  const t = await getTranslations();
  const message = code && isBlockedCode(code) ? t(`errors.${code}`) : t("blocked.generic");
  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-4 p-4">
      <h1 className="text-2xl font-bold">{t("blocked.title")}</h1>
      <p role="alert">{message}</p>
      <p className="text-sm text-muted-foreground">{t("blocked.help")}</p>
      <div className="flex flex-wrap gap-2">
        <Link href="/" className={buttonClass("outline")}>
          {t("blocked.home")}
        </Link>
        <SignOutButton label={t("blocked.switchAccount")} />
      </div>
    </main>
  );
}
