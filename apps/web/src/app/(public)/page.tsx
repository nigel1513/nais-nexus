import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { AccessDemo } from "@/features/landing/components/access-demo";
import { ColumnProfiles } from "@/features/landing/components/column-profiles";
import { HeroWindows } from "@/features/landing/components/hero-windows";
import { OperatorLink, PublicFooter, PublicHeader } from "@/features/landing/components/public-frame";
import { ScrollReveal } from "@/features/landing/components/scroll-reveal";
import { operatorUrl } from "@/features/landing/version";
import { isMocking } from "@/shared/config";
import "@/features/landing/landing.css";

const rich = {
  b: (chunks: React.ReactNode) => <b>{chunks}</b>,
  code: (chunks: React.ReactNode) => <code>{chunks}</code>,
};

function SignIn({ className, label }: { className: string; label: string }) {
  return (
    // No prefetch: /commons redirects until sign-in, and a cached redirect would outlive the sign-in.
    <Link href="/commons" prefetch={false} className={`lp-btn ${className}`}>
      {label}
      <ArrowRight className="lp-arrow" strokeWidth={1.75} aria-hidden />
    </Link>
  );
}

function Check({ pass, label }: { pass: boolean; label: string }) {
  return pass ? (
    <svg className="lp-pass" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} role="img" aria-label={label}>
      <path d="M3 8.5l3 3 7-7" />
    </svg>
  ) : (
    <svg className="lp-fail" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} role="img" aria-label={label}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

/**
 * Public start page, after Observable's home: a dark hero with the product hanging over its edge, then one section per
 * thing the portal does, each with a live product panel. Every panel is a labelled example; nothing here is a statistic.
 * /commons is behind the middleware, so the sign-in links land on Keycloak in real mode and on /mock-login in mock mode.
 */
export default async function LandingPage() {
  const t = await getTranslations("landing");
  const tc = await getTranslations("common");
  const mocking = isMocking();
  const operator = operatorUrl();
  const members: Array<[string, "a" | "b", "lead" | "steward" | "coResearcher", string]> = [
    ["이소재", "a", "lead", "07-01"],
    ["정측정", "a", "steward", "07-01"],
    ["김연구", "b", "coResearcher", "07-15"],
    ["박분석", "b", "coResearcher", "08-03"],
    ["최모델", "b", "coResearcher", "09-20"],
  ];
  const checks = [
    ["metadata", true],
    ["tabular", true],
    ["units", false],
    ["provenance", true],
  ] as const;

  return (
    <div className="lp flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-sm focus:bg-bg focus:p-2">
        {tc("skipToContent")}
      </a>
      <PublicHeader operator={operator} />
      <main id="main" className="break-keep">
        <section className="lp-hero" aria-labelledby="lp-title">
          <div className="lp-wrap">
            <p className="lp-over">
              {t.rich("over", { operator: (chunks) => (operator ? <OperatorLink href={operator}>{chunks}</OperatorLink> : chunks) })}
            </p>
            <h1 id="lp-title" className="lp-h1">
              <span className="lp-line">
                <span>{t("titleLine1")}</span>
              </span>{" "}
              <span className="lp-line">
                <span>{t("titleLine2")}</span>
              </span>
            </h1>
            <p className="lp-prose">{t.rich("prose", rich)}</p>
            <div className="lp-cta">
              <SignIn className="lp-btn-hero" label={t("signIn")} />
              {mocking ? <span className="lp-demo">{t("demoMode")}</span> : null}
              <small>{mocking ? t("demoHint") : t("signInHint")}</small>
            </div>
          </div>
          <HeroWindows />
        </section>

        <ScrollReveal>
          <section className="lp-sec" id="portal" aria-labelledby="lp-data">
            <div className="lp-wrap">
              <p className="lp-kicker lp-reveal">{t("data.kicker")}</p>
              <h2 id="lp-data" className="lp-h2 lp-reveal" data-delay="40">
                {t("data.title")}
              </h2>
              <p className="lp-intro lp-reveal" data-delay="100">
                {t("data.intro")}
              </p>
              <div className="lp-grid">
                <div className="lp-panel-wrap lp-reveal" data-delay="160">
                  <div className="lp-panel lp-ui">
                    <div className="lp-ui-head">
                      <div className="lp-crumbs">{t("data.panelPath")}</div>
                      <div className="lp-ui-title sm">{t("data.panelTitle")}</div>
                      <div className="lp-ui-meta">{t("data.panelHint")}</div>
                    </div>
                    <ColumnProfiles grow="view" interactive label={t("data.profiles")} />
                  </div>
                  <p className="lp-cap">{t("data.caption")}</p>
                </div>
                <div className="lp-notes">
                  {(["profile", "versions", "search"] as const).map((k, i) => (
                    <p key={k} className="lp-reveal" data-delay={240 + i * 60}>
                      {t.rich(`data.notes.${k}`, rich)}
                    </p>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="lp-sec" aria-labelledby="lp-access">
            <div className="lp-wrap">
              <p className="lp-kicker lp-reveal">{t("access.kicker")}</p>
              <h2 id="lp-access" className="lp-h2 lp-reveal" data-delay="40">
                {t("access.title")}
              </h2>
              <p className="lp-intro lp-reveal" data-delay="100">
                {t("access.intro")}
              </p>
              <div className="lp-grid" data-flip="">
                <div className="lp-panel-wrap lp-reveal" data-delay="160">
                  <AccessDemo />
                  <p className="lp-cap">{t("access.caption")}</p>
                </div>
                <div className="lp-notes">
                  <ol className="lp-steps">
                    {(["request", "review", "use", "end"] as const).map((k, i) => (
                      <li key={k} className="lp-reveal" data-delay={200 + i * 60}>
                        <span>{t.rich(`access.steps.${k}`, rich)}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
            </div>
          </section>

          <section className="lp-sec" aria-labelledby="lp-project">
            <div className="lp-wrap">
              <p className="lp-kicker lp-reveal">{t("project.kicker")}</p>
              <h2 id="lp-project" className="lp-h2 lp-reveal" data-delay="40">
                {t("project.title")}
              </h2>
              <p className="lp-intro lp-reveal" data-delay="100">
                {t("project.intro")}
              </p>
              <div className="lp-grid">
                <div className="lp-panel-wrap lp-reveal" data-delay="160">
                  <div className="lp-panel lp-ui">
                    <div className="lp-ui-head">
                      <div className="lp-crumbs">{t("sample.projectCrumb")}</div>
                      <div className="lp-ui-title sm">{t("sample.project")}</div>
                      <div className="lp-ui-meta">
                        <span>{t("sample.projectStart")}</span>
                        <span>{t("sample.projectOrgs")}</span>
                        <span>{t("sample.projectData")}</span>
                      </div>
                    </div>
                    <table className="lp-rows">
                      <thead>
                        <tr>
                          <th scope="col">{t("ui.member")}</th>
                          <th scope="col">{t("ui.org")}</th>
                          <th scope="col">{t("ui.role")}</th>
                          <th scope="col" className="lp-hide-sm">
                            {t("ui.joined")}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {members.map(([name, org, role, joined], i) => (
                          <tr key={name} className="lp-reveal" data-delay={260 + i * 50}>
                            <td>
                              <span className="lp-who">
                                <span className="lp-av" data-org={org} aria-hidden>
                                  {name[0]}
                                </span>
                                {name}
                              </span>
                            </td>
                            <td>{t(org === "a" ? "sample.orgA" : "sample.orgB")}</td>
                            <td>
                              <span className="lp-chip" data-tone={role === "lead" ? "accent" : "neutral"}>
                                {t(`ui.${role}`)}
                              </span>
                            </td>
                            <td className="lp-mono lp-hide-sm">{joined}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="lp-cap">{t("project.caption")}</p>
                </div>
                <div className="lp-notes">
                  {(["manage", "rights"] as const).map((k, i) => (
                    <p key={k} className="lp-reveal" data-delay={240 + i * 60}>
                      {t.rich(`project.notes.${k}`, rich)}
                    </p>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="lp-sec" aria-labelledby="lp-readiness">
            <div className="lp-wrap">
              <p className="lp-kicker lp-reveal">{t("readiness.kicker")}</p>
              <h2 id="lp-readiness" className="lp-h2 lp-reveal" data-delay="40">
                {t("readiness.title")}
              </h2>
              <p className="lp-intro lp-reveal" data-delay="100">
                {t("readiness.intro")}
              </p>
              <div className="lp-grid" data-flip="">
                <div className="lp-panel-wrap lp-reveal" data-delay="160">
                  <div className="lp-panel lp-ui">
                    <div className="lp-ui-head">
                      <div className="lp-crumbs">{t("sample.readinessCrumb")}</div>
                      <div className="lp-ui-title sm">{t("sample.dataset")}</div>
                    </div>
                    <div className="lp-score">
                      <b>8/10</b>
                      <div className="lp-meter" aria-hidden>
                        <i />
                      </div>
                      <span className="lp-chip" data-tone="ok">
                        {t("sample.trainable")}
                      </span>
                    </div>
                    <ul className="lp-checks">
                      {checks.map(([k, pass], i) => (
                        <li key={k} className="lp-reveal" data-delay={300 + i * 60}>
                          <Check pass={pass} label={t(pass ? "ui.passLabel" : "ui.fixLabel")} />
                          <span>
                            {t(`readiness.checks.${k}`)}
                            <small>{t.rich(`readiness.checks.${k}Hint`, rich)}</small>
                          </span>
                          <span className="lp-chip" data-tone={pass ? "ok" : "bad"} aria-hidden>
                            {t(pass ? "ui.pass" : "ui.fix")}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <p className="lp-cap">{t("readiness.caption")}</p>
                </div>
                <div className="lp-notes">
                  {(["items", "versions"] as const).map((k, i) => (
                    <p key={k} className="lp-reveal" data-delay={240 + i * 60}>
                      {t.rich(`readiness.notes.${k}`, rich)}
                    </p>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="lp-close" aria-labelledby="lp-close">
            <div className="lp-wrap lp-close-in">
              <div className="lp-reveal">
                <h2 id="lp-close">{t("close.title")}</h2>
                <p>{t("close.body")}</p>
              </div>
              <div className="lp-reveal" data-delay="80">
                <SignIn className="lp-btn-ink" label={t("signIn")} />
              </div>
            </div>
          </section>
        </ScrollReveal>
      </main>
      <PublicFooter operator={operator} />
    </div>
  );
}
