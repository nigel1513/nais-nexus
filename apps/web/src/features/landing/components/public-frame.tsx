import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { APP_VERSION, supportContact } from "../version";

/** Page column shared by the header, main and footer so their left edges line up on one grid. */
export const publicColumn = "mx-auto w-full max-w-[1120px] px-4 md:px-6 xl:px-8";

/** Three bars of a histogram: the product mark, echoing the column profiles on the page. */
function Mark() {
  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0" aria-hidden>
      <rect x="1" y="7" width="4" height="8" className="fill-fg-muted" />
      <rect x="6" y="2" width="4" height="13" className="fill-fg" />
      <rect x="11" y="9" width="4" height="6" className="fill-accent" />
    </svg>
  );
}

export function PublicHeader() {
  const t = useTranslations();
  return (
    <header className="border-b border-border">
      <div className={`${publicColumn} flex h-14 items-center justify-between gap-4`}>
        <Link href="/" className="flex min-w-0 items-center gap-2 rounded-xs text-heading text-fg outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
          <Mark />
          <span className="truncate">{t("common.appName")}</span>
        </Link>
        <span className="flex shrink-0 items-center gap-1.5 text-small text-fg-muted">
          <span className="size-1.5 rounded-full bg-success-solid" aria-hidden />
          {t("landing.internal")}
        </span>
      </div>
    </header>
  );
}

export function PublicFooter() {
  const t = useTranslations("landing");
  const contact = supportContact();
  return (
    <footer className="mt-auto border-t border-border bg-bg-subtle">
      <div className={`${publicColumn} grid gap-4 py-6 md:grid-cols-12 md:gap-8`}>
        <p className="flex gap-2 break-keep text-small text-fg md:col-span-7">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-fg-muted" strokeWidth={1.75} aria-hidden />
          {t("notice")}
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-small md:col-span-5 md:justify-self-end">
          <dt className="text-fg-muted">{t("support")}</dt>
          <dd id="support" className="min-w-0 break-words text-fg">
            {contact ? (
              contact.includes("@") ? (
                <a href={`mailto:${contact}`} className="underline decoration-border-strong underline-offset-4 hover:decoration-fg">
                  {contact}
                </a>
              ) : (
                contact
              )
            ) : (
              <span className="text-fg-muted">{t("supportPending")}</span>
            )}
          </dd>
          <dt className="text-fg-muted">{t("version")}</dt>
          <dd className="num font-mono text-mono text-fg">v{APP_VERSION}</dd>
        </dl>
      </div>
    </footer>
  );
}
