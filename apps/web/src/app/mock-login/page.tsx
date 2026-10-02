import { ArrowLeft, FlaskConical } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { MockLoginForm } from "@/features/auth/components/mock-login-form";
import { safeCallbackUrl } from "@/features/auth/redirects";
import { PublicFooter, PublicHeader } from "@/features/landing/components/public-frame";
import { operatorUrl } from "@/features/landing/version";
import { SEED_USERS } from "@/mocks/fixtures";
import { isMocking } from "@/shared/config";
import "@/features/landing/landing.css";

export default async function MockLoginPage({ searchParams }: { searchParams: Promise<{ callbackUrl?: string }> }) {
  if (!isMocking()) notFound();
  const { callbackUrl } = await searchParams;
  const t = await getTranslations();
  const operator = operatorUrl();
  return (
    <div className="lp flex min-h-screen flex-col">
      <PublicHeader operator={operator} />
      <main id="main" className="mx-auto w-full max-w-[420px] break-keep px-4 pb-16 pt-12 md:pt-20">
        <span className="lp-demo gap-1.5">
          <FlaskConical className="size-3.5" strokeWidth={1.75} aria-hidden />
          {t("auth.mockBadge")}
        </span>
        <h1 className="mt-3 text-[28px] font-[750] leading-[1.25] tracking-[-0.035em] text-fg">{t("auth.mockTitle")}</h1>
        <p className="mt-2 text-[15px] leading-[1.7] text-fg-muted">{t("auth.mockDescription")}</p>
        <div className="lp-panel mt-8 p-5">
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
      <PublicFooter operator={operator} />
    </div>
  );
}
