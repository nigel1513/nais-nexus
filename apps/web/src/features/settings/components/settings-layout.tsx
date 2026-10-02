"use client";
import { Card, CardDescription, CardTitle, cn, focusRing } from "@nais/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useSyncExternalStore, type ReactNode } from "react";
import { hasOrgRole, useMeData } from "@/shared/hooks/use-me";

export const SETTINGS_SECTIONS = ["profile", "researcher-number", "theme", "language", "notifications"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

const SECTION_LABEL: Record<SettingsSection, string> = {
  profile: "settings.nav.profile",
  "researcher-number": "settings.nav.researcherNumber",
  theme: "settings.nav.theme",
  language: "settings.nav.language",
  notifications: "settings.nav.notifications",
};

function subscribeHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** The section the address points at (#theme …); the first one when there is none. Server render: none. */
function useHashSection(): SettingsSection | null {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash, () => null);
  if (hash === null) return null;
  const id = hash.replace(/^#/, "");
  return (SETTINGS_SECTIONS as readonly string[]).includes(id) ? (id as SettingsSection) : "profile";
}

const itemClass = (active: boolean) =>
  cn(
    "flex h-8 shrink-0 items-center whitespace-nowrap rounded-sm px-2.5 text-body",
    active ? "bg-bg-active font-medium text-fg" : "text-fg-muted hover:bg-bg-hover hover:text-fg",
    focusRing,
  );

/**
 * Settings template (spec §5): a left sub-nav (profile, researcher number, theme, language, notifications, and
 * 기관 관리 for ORG_ADMIN / PLATFORM_ADMIN) beside a 768px column of section cards. Below lg the nav becomes a
 * row that scrolls inside itself.
 */
export function SettingsLayout({ page, header, children }: { page: "account" | "organization"; header: ReactNode; children: ReactNode }) {
  const t = useTranslations();
  const me = useMeData();
  const hashSection = useHashSection();
  const canAdmin = hasOrgRole(me, "ORG_ADMIN") || me.platform_roles.includes("PLATFORM_ADMIN");
  const active = page === "account" ? hashSection : null;
  const navRef = useRef<HTMLElement>(null);
  // Phones: the nav is a row that scrolls sideways; bring the current item into view without moving the page.
  useEffect(() => {
    const reveal = () => {
      const nav = navRef.current;
      const current = nav?.querySelector<HTMLElement>("[aria-current]");
      if (!nav || !current || nav.scrollWidth <= nav.clientWidth) return;
      nav.scrollLeft = current.offsetLeft - nav.clientWidth / 2 + current.offsetWidth / 2;
    };
    reveal();
    window.addEventListener("resize", reveal);
    return () => window.removeEventListener("resize", reveal);
  }, [active, page]);

  return (
    <>
      {header}
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[12rem_minmax(0,48rem)] lg:items-start lg:gap-12">
        <nav ref={navRef} aria-label={t("settings.nav.label")} className="relative -mx-1 overflow-x-auto px-1 pb-1 lg:sticky lg:top-16 lg:mx-0 lg:overflow-visible lg:p-0">
          <ul className="flex gap-1 border-b border-border pb-2 lg:flex-col lg:gap-0.5 lg:border-0 lg:pb-0">
            {SETTINGS_SECTIONS.map((s) => {
              const isActive = active === s;
              const label = t(SECTION_LABEL[s]);
              return (
                <li key={s}>
                  {page === "account" ? (
                    <a href={`#${s}`} aria-current={isActive ? "location" : undefined} className={itemClass(isActive)}>
                      {label}
                    </a>
                  ) : (
                    <Link href={`/settings#${s}`} className={itemClass(false)}>
                      {label}
                    </Link>
                  )}
                </li>
              );
            })}
            {canAdmin ? (
              <li className="flex shrink-0 items-center lg:mt-3 lg:block lg:border-t lg:border-border lg:pt-3">
                <span aria-hidden="true" className="mx-1 h-4 w-px bg-border lg:hidden" />
                <Link
                  href="/settings/organization"
                  aria-current={page === "organization" ? "page" : undefined}
                  className={itemClass(page === "organization")}
                >
                  {t("nav.organization")}
                </Link>
              </li>
            ) : null}
          </ul>
        </nav>
        <div className="flex min-w-0 flex-col gap-6">{children}</div>
      </div>
    </>
  );
}

/**
 * One settings section: a bordered card (title, one muted line, body) with an optional footer bar on bg-subtle that
 * carries the hint on the left and the section's actions on the right (Vercel settings pattern).
 */
export function SettingsSectionCard({
  id,
  title,
  description,
  actions,
  footer,
  children,
  className,
  bodyClassName,
}: {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  /** Small actions next to the title (e.g. 모두 읽음). */
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  const headingId = useId();
  return (
    <Card id={id} aria-labelledby={headingId} className={cn("scroll-mt-16", className)}>
      <div className="flex items-start justify-between gap-4 px-5 pt-5">
        <div className="min-w-0">
          <CardTitle id={headingId}>{title}</CardTitle>
          {description ? <CardDescription className="mt-1">{description}</CardDescription> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      <div className={cn("px-5 pb-5 pt-4", bodyClassName)}>{children}</div>
      {footer ? (
        <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-b-md border-t border-border bg-bg-subtle px-5 py-2.5">
          {footer}
        </div>
      ) : null}
    </Card>
  );
}
