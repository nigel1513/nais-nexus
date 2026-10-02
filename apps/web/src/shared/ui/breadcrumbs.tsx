"use client";
import { cn } from "@nais/ui";
import { Slash } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { sectionFor, type NavItem } from "./nav";

export type Crumb = { label: string; href?: string };

const SetCrumbs = createContext<(items: Crumb[] | null) => void>(() => {});
const Crumbs = createContext<Crumb[] | null>(null);

export function BreadcrumbsProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Crumb[] | null>(null);
  return (
    <SetCrumbs.Provider value={setItems}>
      <Crumbs.Provider value={items}>{children}</Crumbs.Provider>
    </SetCrumbs.Provider>
  );
}

/**
 * A screen adds its own trail after the section crumb the top bar derives from the path, e.g.
 * `useBreadcrumbs([{ label: dataset.title }])` on a data card gives "데이터 / 리튬이온 배터리 셀 사이클 시험 데이터".
 * Cleared when the screen unmounts. Outside the shell (screen tests) it does nothing.
 */
export function useBreadcrumbs(items: Crumb[]): void {
  const set = useContext(SetCrumbs);
  const key = JSON.stringify(items);
  useEffect(() => {
    set(JSON.parse(key) as Crumb[]);
    return () => set(null);
  }, [key, set]);
}

/** Top-bar trail: every crumb but the last is a link; the last is the current page. On phones only the last shows (none for a one-crumb trail). */
export function Breadcrumbs({ destinations, className }: { destinations: NavItem[]; className?: string }) {
  const t = useTranslations();
  const pathname = usePathname();
  const extra = useContext(Crumbs) ?? [];
  const section = sectionFor(pathname, destinations);
  const trail: Crumb[] = [...(section ? [{ label: section.label, href: section.href }] : []), ...extra];
  if (!trail.length) return <div className={className} />;
  return (
    <nav aria-label={t("common.breadcrumb")} className={cn("min-w-0", className)}>
      <ol className="flex min-w-0 items-center gap-1.5 text-body">
        {trail.map((c, i) => {
          const last = i === trail.length - 1;
          return (
            // Phones show only the last crumb, without its separator; a lone crumb would just repeat the h1, so none.
            <li key={`${i}-${c.label}`} className={cn("min-w-0 items-center gap-1.5", last && trail.length > 1 ? "flex" : "hidden shrink md:flex")}>
              {i > 0 ? <Slash aria-hidden="true" className="hidden size-3.5 shrink-0 -rotate-12 text-border-strong md:block" strokeWidth={1.75} /> : null}
              {last ? (
                <span aria-current="page" className="truncate font-medium text-fg">
                  {c.label}
                </span>
              ) : !c.href ? (
                <span className="max-w-60 truncate text-fg-muted">{c.label}</span>
              ) : (
                <Link
                  href={c.href}
                  className="max-w-60 truncate rounded-xs text-fg-muted outline-none hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  {c.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
