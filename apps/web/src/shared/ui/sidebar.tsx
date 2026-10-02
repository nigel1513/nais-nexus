"use client";
import { Badge, IconButton, Tooltip, cn, focusRing } from "@nais/ui";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useState } from "react";
import { useListAccessRequests } from "@/features/governance/api";
import type { Me } from "@/shared/api/types";
import { hasOrgRole } from "@/shared/hooks/use-me";
import { sectionFor, useDestinations, useNavGroups, type NavItem } from "./nav";
import { UserMenu } from "./user-menu";

const STORAGE_KEY = "nais-sidebar-collapsed";

/** Collapsed (64px icon rail) or not, remembered per browser. Storage may throw (private mode, blocked site data). */
export function useSidebarCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      // Read after mount: the server render has no storage, and the two renders must match.
      if (window.localStorage.getItem(STORAGE_KEY) === "1") setCollapsed(true);
    } catch {
      /* stays expanded */
    }
  }, []);
  const toggle = useCallback(() => {
    setCollapsed((c) => {
      try {
        window.localStorage.setItem(STORAGE_KEY, c ? "0" : "1");
      } catch {
        /* the choice lasts for this page only */
      }
      return !c;
    });
  }, []);
  return [collapsed, toggle];
}

/** Requests waiting for this steward's decision; the same query (and cache) as the access screen's review tab. */
function useReviewCount(me: Me): number {
  const steward = hasOrgRole(me, "DATA_STEWARD");
  const review = useListAccessRequests({ role: "reviewer", status: ["SUBMITTED", "UNDER_REVIEW"], limit: 100 }, { enabled: steward });
  return steward ? (review.data?.pages[0]?.items.length ?? 0) : 0;
}

function Brand({ compact }: { compact: boolean }) {
  const t = useTranslations();
  return (
    <Link href="/commons" className={cn("flex min-w-0 items-center gap-2 rounded-sm", focusRing)}>
      <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-primary text-caption font-semibold text-primary-fg">
        N
      </span>
      <span className={compact ? "sr-only" : "truncate text-body font-semibold text-fg"}>{t("shell.brand")}</span>
    </Link>
  );
}

function NavLink({ item, active, compact, count, onNavigate }: { item: NavItem; active: boolean; compact: boolean; count: number; onNavigate?: () => void }) {
  const t = useTranslations();
  const Icon = item.icon;
  const row = cn("flex h-8 items-center gap-2 rounded-sm text-body font-medium", compact ? "w-8 justify-center" : "px-2");
  if (item.soon) {
    return (
      <span aria-disabled="true" className={cn(row, "cursor-default text-fg-subtle")}>
        <Icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
        <span className={compact ? "sr-only" : "min-w-0 flex-1 truncate"}>{item.label}</span>
        <Badge className={compact ? "sr-only" : undefined}>{t("shell.soon")}</Badge>
      </span>
    );
  }
  const link = (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      className={cn(row, focusRing, active ? "bg-bg-active text-fg" : "text-fg-muted hover:bg-bg-hover hover:text-fg")}
    >
      <Icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
      <span className={compact ? "sr-only" : "min-w-0 flex-1 truncate"}>{item.label}</span>
      {count > 0 ? (
        <>
          <span aria-hidden="true" className={compact ? "sr-only" : "num text-caption text-fg-muted"}>
            {count > 99 ? "99+" : count}
          </span>
          <span className="sr-only"> ({t("shell.reviewPending", { count })})</span>
        </>
      ) : null}
    </Link>
  );
  if (!compact) return link;
  return (
    <Tooltip content={count > 0 ? `${item.label} · ${count}` : item.label} side="right">
      {link}
    </Tooltip>
  );
}

/**
 * Left navigation (spec §3): 240px on bg-subtle, or a 64px icon rail when collapsed; inside the mobile sheet it is
 * always full width. Groups 작업 / 거버넌스 / 관리, the steward's review count on 접근 관리, the user menu at the foot.
 */
export function Sidebar({
  me,
  collapsed = false,
  onToggle,
  onNavigate,
}: {
  me: Me;
  collapsed?: boolean;
  /** Absent in the mobile sheet, which has its own close button. */
  onToggle?: () => void;
  onNavigate?: () => void;
}) {
  const t = useTranslations();
  const pathname = usePathname();
  const groups = useNavGroups(me);
  const current = sectionFor(pathname, useDestinations(me));
  const reviewCount = useReviewCount(me);
  const id = useId();

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Expanded: mark + name + collapse on one row. Rail: the mark keeps its place; expand sits right under it. */}
      <div className={cn("flex h-12 shrink-0 items-center gap-2", collapsed ? "justify-center px-2" : "pl-4 pr-2")}>
        <Brand compact={collapsed} />
        {onToggle && !collapsed ? (
          <IconButton label={t("shell.collapseSidebar")} onClick={onToggle} size="sm" className="ml-auto">
            <PanelLeftClose aria-hidden="true" strokeWidth={1.75} />
          </IconButton>
        ) : null}
      </div>
      {onToggle && collapsed ? (
        <div className="flex shrink-0 justify-center pb-1">
          <IconButton label={t("shell.expandSidebar")} onClick={onToggle} size="md">
            <PanelLeftOpen aria-hidden="true" strokeWidth={1.75} />
          </IconButton>
        </div>
      ) : null}
      <nav aria-label={t("shell.mainNav")} className={cn("min-h-0 flex-1 overflow-y-auto pb-4", collapsed ? "px-4" : "px-2")}>
        {groups.map((g, gi) => (
          <div key={g.key} className={gi > 0 ? "mt-4" : "mt-1"}>
            {collapsed ? (
              <>
                {gi > 0 ? <div aria-hidden="true" className="mx-1 mb-4 h-px bg-border" /> : null}
                <span id={`${id}-${g.key}`} className="sr-only">
                  {g.label}
                </span>
              </>
            ) : (
              <span id={`${id}-${g.key}`} className="flex h-7 items-center px-2 text-caption text-fg-muted">
                {g.label}
              </span>
            )}
            <ul aria-labelledby={`${id}-${g.key}`} className="flex flex-col gap-px">
              {g.items.map((item) => (
                <li key={item.href}>
                  <NavLink
                    item={item}
                    active={current?.href === item.href}
                    compact={collapsed}
                    count={item.href === "/commons/access" ? reviewCount : 0}
                    onNavigate={onNavigate}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className={cn("shrink-0 border-t border-border p-2", collapsed && "flex justify-center")}>
        <UserMenu me={me} compact={collapsed} />
      </div>
    </div>
  );
}
