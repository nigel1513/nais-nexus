"use client";
import { Activity, BookText, Building2, Compass, Database, FolderKanban, LayoutDashboard, NotebookPen, Settings, ShieldCheck, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import type { Me } from "@/shared/api/types";
import { hasOrgRole } from "@/shared/hooks/use-me";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown but not a link yet ("예정"): no dead links. */
  soon?: boolean;
};
export type NavGroup = { key: "work" | "governance" | "admin"; label: string; items: NavItem[] };

/**
 * Sidebar sections (spec §3; data-hub plan §3: 데이터 허브 is the discovery home, 전체 데이터 the full search). Reserved P1 routes (/marketplace, /compute) stay hidden (M10 §7.13).
 * 기관 관리 is for ORG_ADMIN or PLATFORM_ADMIN only.
 */
export function useNavGroups(me: Me): NavGroup[] {
  const t = useTranslations();
  const admin = hasOrgRole(me, "ORG_ADMIN") || me.platform_roles.includes("PLATFORM_ADMIN");
  return useMemo(() => {
    const groups: NavGroup[] = [
      {
        key: "work",
        label: t("shell.groupWork"),
        items: [
          { href: "/commons", label: t("nav.dashboard"), icon: LayoutDashboard },
          { href: "/commons/hub", label: t("nav.hub"), icon: Compass },
          { href: "/commons/data", label: t("nav.data"), icon: Database },
          { href: "/commons/projects", label: t("nav.projects"), icon: FolderKanban },
          { href: "/commons/notes", label: t("nav.notes"), icon: BookText },
          { href: "/commons/notebooks", label: t("nav.notebooks"), icon: NotebookPen, soon: true },
        ],
      },
      {
        key: "governance",
        label: t("shell.groupGovernance"),
        items: [
          { href: "/commons/access", label: t("nav.access"), icon: ShieldCheck },
          { href: "/commons/activity", label: t("nav.activity"), icon: Activity },
        ],
      },
    ];
    if (admin) groups.push({ key: "admin", label: t("shell.groupAdmin"), items: [{ href: "/settings/organization", label: t("nav.organization"), icon: Building2 }] });
    return groups;
  }, [t, admin]);
}

/** Every screen the user can open from the shell: the sidebar items plus settings (reached from the user menu). */
export function useDestinations(me: Me): NavItem[] {
  const t = useTranslations();
  const groups = useNavGroups(me);
  return useMemo(
    () => [...groups.flatMap((g) => g.items.filter((i) => !i.soon)), { href: "/settings", label: t("nav.settings"), icon: Settings }],
    [groups, t],
  );
}

/** The destination that owns `pathname`: the longest matching href, so /commons only matches the dashboard itself. */
export function sectionFor(pathname: string, items: NavItem[]): NavItem | undefined {
  let best: NavItem | undefined;
  for (const i of items) {
    if (i.soon) continue;
    const hit = i.href === "/commons" ? pathname === "/commons" : pathname === i.href || pathname.startsWith(`${i.href}/`);
    if (hit && (!best || i.href.length > best.href.length)) best = i;
  }
  return best;
}
