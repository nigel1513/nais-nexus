import { Badge, buttonClass } from "@nais/ui";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PublicFooter, PublicHeader, publicColumn } from "@/features/landing/components/public-frame";
import { SampleFigure } from "@/features/landing/components/sample-figure";
import { isMocking } from "@/shared/config";

const CONTENTS = ["data", "projects", "access", "readiness"] as const;

/**
 * Public start page of an internal portal: who it is for, one way in (NST SSO), what is inside, and the audit notice.
 * /commons is behind the middleware, so the button lands on Keycloak in real mode and on /mock-login in mock mode.
 */
export default async function LandingPage() {
  const t = await getTranslations();
  const mocking = isMocking();
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-sm focus:bg-bg focus:p-2">
        {t("common.skipToContent")}
      </a>
      <PublicHeader />
      <main id="main" className={`${publicColumn} pb-16 pt-12 md:pb-24 md:pt-20`}>
        <section aria-labelledby="landing-title" className="grid grid-cols-1 gap-12 break-keep lg:grid-cols-12 lg:gap-8">
          <div className="lg:col-span-6">
            <h1 id="landing-title" className="flex flex-col gap-2">
              <span className="text-lead font-medium text-fg-muted md:text-hero-context">{t("landing.context")}</span>
              <span className="text-hero-sm text-fg md:text-hero">{t("landing.title")}</span>
            </h1>
            <p className="mt-6 max-w-[34em] text-lead text-fg-muted">{t("landing.lead")}</p>
            <div className="mt-10 flex flex-wrap items-center gap-3">
              <Link href="/commons" className={buttonClass("primary", "lg")}>
                {t("landing.signIn")}
                <ArrowRight strokeWidth={1.75} aria-hidden />
              </Link>
              {mocking ? <Badge tone="warning">{t("landing.demoMode")}</Badge> : null}
            </div>
            <p className="mt-3 max-w-[34em] text-small text-fg-muted">{mocking ? t("landing.demoHint") : t("landing.signInHint")}</p>
          </div>
          <div className="lg:col-span-5 lg:col-start-8 lg:pt-2">
            <SampleFigure />
          </div>
        </section>

        <section aria-labelledby="landing-contents" className="mt-16 grid grid-cols-1 break-keep border-t border-border pt-6 md:mt-24 lg:grid-cols-12 lg:gap-8">
          <h2 id="landing-contents" className="text-small font-medium text-fg-muted lg:col-span-3">
            {t("landing.contentsTitle")}
          </h2>
          <ol className="mt-4 lg:col-span-9 lg:mt-0">
            {CONTENTS.map((key, i) => (
              <li
                key={key}
                className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 gap-y-1 border-b border-border py-4 first:pt-0 md:grid-cols-[2rem_11rem_minmax(0,1fr)] md:gap-x-6"
              >
                <span className="num font-mono text-mono leading-6 text-fg-muted" aria-hidden>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div>
                  <h3 className="text-heading text-fg">{t(`landing.contents.${key}.title`)}</h3>
                  <span className="font-mono text-mono text-fg-muted">{t(`landing.contents.${key}.where`)}</span>
                </div>
                <p className="col-start-2 text-body text-fg-muted md:col-start-auto md:pt-0.5">{t(`landing.contents.${key}.body`)}</p>
              </li>
            ))}
          </ol>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
