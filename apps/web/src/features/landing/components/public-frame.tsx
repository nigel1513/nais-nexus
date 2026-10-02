import { useTranslations } from "next-intl";
import Link from "next/link";
import { APP_VERSION, supportContact } from "../version";
import { StickyBar } from "./sticky-bar";

/** Three bars of a histogram: the product mark, echoing the column profiles on the start page. */
function Mark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden>
      <rect x="1" y="7" width="4" height="8" fill="var(--color-fg-subtle)" />
      <rect x="6" y="2" width="4" height="13" fill="var(--color-fg)" />
      <rect x="11" y="9" width="4" height="6" fill="var(--color-accent)" />
    </svg>
  );
}

/** Link to the operating organisation; opens in a new tab and says so to screen readers. */
export function OperatorLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  const t = useTranslations("landing");
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className ? `lp-ext ${className}` : "lp-ext"}>
      {children}
      <span className="sr-only"> ({t("newTab")})</span>
    </a>
  );
}

export function PublicHeader({ operator }: { operator: string | null }) {
  const t = useTranslations();
  return (
    <StickyBar>
      <div className="lp-wrap lp-bar-in">
        <nav className="lp-nav" aria-label={t("landing.nav.label")}>
          <Link href="/#portal">{t("landing.nav.guide")}</Link>
          <a href="#support">{t("landing.nav.support")}</a>
          {operator ? <OperatorLink href={operator}>{t("landing.operator")}</OperatorLink> : null}
        </nav>
        <Link href="/" className="lp-logo">
          <Mark />
          {t("common.appName")}
        </Link>
        <div className="lp-bar-end">
          {/* No prefetch: before sign-in /commons answers with a redirect, and a cached one would bounce the user back here after signing in. */}
          <Link href="/commons" prefetch={false} className="lp-btn lp-btn-outline">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden>
              <rect x="3" y="7" width="10" height="7" rx="1.5" />
              <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
            </svg>
            <span>
              <span className="lp-long">{t("landing.signInPrefix")}</span>
              {t("landing.signInShort")}
            </span>
          </Link>
        </div>
      </div>
    </StickyBar>
  );
}

export function PublicFooter({ operator }: { operator: string | null }) {
  const t = useTranslations("landing");
  const contact = supportContact();
  return (
    <footer className="lp-foot" id="support">
      <div className="lp-wrap lp-foot-in">
        <div>
          <p className="lp-notice">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden>
              <path d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6l7-3z" />
              <path d="M9 12l2 2 4-4" />
            </svg>
            {t("notice")}
          </p>
          {operator ? (
            <p className="lp-operator">
              {t("operatedBy")} <OperatorLink href={operator}>{t("operatorFull")}</OperatorLink>
            </p>
          ) : null}
        </div>
        <dl className="lp-meta">
          <dt>{t("support")}</dt>
          <dd>
            {contact ? (
              contact.includes("@") ? (
                <a href={`mailto:${contact}`} className="underline decoration-border-strong underline-offset-4">
                  {contact}
                </a>
              ) : (
                contact
              )
            ) : (
              t("supportPending")
            )}
          </dd>
          <dt>{t("version")}</dt>
          <dd className="lp-mono">v{APP_VERSION}</dd>
        </dl>
      </div>
    </footer>
  );
}
