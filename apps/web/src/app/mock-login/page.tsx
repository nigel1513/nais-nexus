import { Badge } from "@nais/ui";
import { ArrowLeft, FlaskConical } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { MockLoginForm } from "@/features/auth/components/mock-login-form";
import { safeCallbackUrl } from "@/features/auth/redirects";
import { PublicFooter, PublicHeader } from "@/features/landing/components/public-frame";
import { SEED_USERS } from "@/mocks/fixtures";
import { isMocking } from "@/shared/config";

export default async function MockLoginPage({ searchParams }: { searchParams: Promise<{ callbackUrl?: string }> }) {
  if (!isMocking()) notFound();
  const { callbackUrl } = await searchParams;
  const t = await getTranslations();
  return (
    <div className="flex min-h-screen flex-col">
      <PublicHeader />
      <main id="main" className="mx-auto w-full max-w-[420px] px-4 pb-16 pt-12 md:pt-20">
        <Badge tone="warning">
          <FlaskConical strokeWidth={1.75} aria-hidden />
          {t("auth.mockBadge")}
        </Badge>
        <h1 className="mt-3 text-display text-fg">{t("auth.mockTitle")}</h1>
        <p className="mt-2 break-keep text-body text-fg-muted">{t("auth.mockDescription")}</p>
        <div className="mt-8 rounded-md border border-border bg-bg-panel p-5">
          <MockLoginForm callbackUrl={safeCallbackUrl(callbackUrl)} users={SEED_USERS} />
        </div>
        <Link
          href="/"
          className="mt-6 inline-flex items-center gap-1.5 rounded-xs text-small text-fg-muted outline-none hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <ArrowLeft className="size-4" strokeWidth={1.75} aria-hidden />
          {t("auth.mockBack")}
        </Link>
      </main>
      <PublicFooter />
    </div>
  );
}
