"use client";
import { Badge, Input, cn } from "@nais/ui";
import { Building2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import type { Me } from "@/shared/api/types";
import { NotificationBell } from "./notification-bell";
import { UserMenu } from "./user-menu";

type NavItem = { href: string; label: string; exact?: boolean };

export function AppShell({ me, children }: { me: Me; children: ReactNode }) {
  const t = useTranslations();
  const pathname = usePathname();
  const router = useRouter();
  const [q, setQ] = useState("");
  const nav: NavItem[] = [
    { href: "/commons", label: t("nav.dashboard"), exact: true },
    { href: "/commons/projects", label: t("nav.projects") },
    { href: "/commons/data", label: t("nav.data") },
    { href: "/commons/access", label: t("nav.access") },
    { href: "/commons/activity", label: t("nav.activity") },
    // Reserved P1 routes (/marketplace, /compute) are intentionally not listed (M10 §7.13).
    ...(me.org_roles.includes("ORG_ADMIN") ? [{ href: "/settings/organization", label: t("nav.organization") }] : []),
  ];
  const active = (i: NavItem) => (i.exact ? pathname === i.href : pathname === i.href || pathname.startsWith(`${i.href}/`));

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-background focus:p-2 focus:outline-2 focus:outline-ring"
      >
        {t("common.skipToContent")}
      </a>
      <header className="sticky top-0 z-30 border-b border-border bg-background">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-2">
          <Link href="/commons" className="text-lg font-bold">
            {t("common.appName")}
          </Link>
          <form
            role="search"
            className="order-last w-full md:order-none md:w-auto md:max-w-md md:flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              const v = q.trim();
              router.push(v ? `/commons/data?q=${encodeURIComponent(v)}` : "/commons/data");
            }}
          >
            <label htmlFor="global-search" className="sr-only">
              {t("shell.searchLabel")}
            </label>
            <Input id="global-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("shell.searchPlaceholder")} />
          </form>
          <div className="ml-auto flex items-center gap-2">
            <NotificationBell />
            <Badge tone="info" className="hidden sm:inline-flex">
              <Building2 aria-hidden="true" className="h-3.5 w-3.5" />
              {me.organization.name}
            </Badge>
            <UserMenu me={me} />
          </div>
        </div>
        <nav aria-label={t("shell.mainNav")} className="mx-auto max-w-7xl px-4">
          <ul className="flex flex-wrap gap-1">
            {nav.map((i) => (
              <li key={i.href}>
                <Link
                  href={i.href}
                  aria-current={active(i) ? "page" : undefined}
                  className={cn(
                    "inline-flex min-h-10 items-center border-b-2 px-3 text-sm",
                    active(i) ? "border-primary font-semibold" : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {i.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 focus:outline-none">
        {children}
      </main>
    </div>
  );
}
