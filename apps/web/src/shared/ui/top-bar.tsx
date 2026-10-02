"use client";
import { IconButton, Kbd, buttonClass, cn } from "@nais/ui";
import { Menu, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Breadcrumbs } from "./breadcrumbs";
import { useCommandPalette } from "./command-palette";
import type { NavItem } from "./nav";
import { NotificationBell } from "./notification-bell";

/** ⌘ on Apple keyboards, Ctrl elsewhere; null until mounted (the server cannot know), so nothing flips on screen. */
function useModKey(): "⌘" | "Ctrl" | null {
  const [mod, setMod] = useState<"⌘" | "Ctrl" | null>(null);
  useEffect(() => {
    const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
    setMod(/mac|iphone|ipad/i.test(platform) ? "⌘" : "Ctrl");
  }, []);
  return mod;
}

/**
 * 48px opaque bar over the content (spec §3): breadcrumbs left; notifications and the ⌘K search right.
 * On phones the 메뉴 button opens the navigation sheet.
 */
export function TopBar({ destinations, onOpenMenu, className }: { destinations: NavItem[]; onOpenMenu: () => void; className?: string }) {
  const t = useTranslations();
  const { setOpen } = useCommandPalette();
  const mod = useModKey();
  return (
    <header className={cn("sticky top-0 z-[var(--z-header)] flex h-12 shrink-0 items-center gap-2 border-b border-border bg-bg px-4 md:px-6 xl:px-8", className)}>
      <IconButton label={t("shell.openMenu")} tooltip={false} onClick={onOpenMenu} className="-ml-1.5 md:hidden">
        <Menu aria-hidden="true" strokeWidth={1.75} />
      </IconButton>
      <Breadcrumbs destinations={destinations} className="flex-1" />
      <div className="flex shrink-0 items-center gap-1">
        <NotificationBell />
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-keyshortcuts="Meta+K Control+K"
          className={buttonClass(
            "secondary",
            "md",
            "w-8 justify-center px-0 text-fg-muted max-md:border-transparent max-md:bg-transparent md:w-48 md:justify-start md:px-2.5 md:text-small",
          )}
        >
          <Search aria-hidden="true" strokeWidth={1.75} />
          <span className="sr-only md:not-sr-only md:flex-1 md:text-left">{t("shell.search")}</span>
          {/* Invisible (not absent) until the platform is known: keeps the width, avoids a Ctrl→⌘ flash. */}
          <Kbd aria-hidden="true" className={cn("hidden md:inline-flex", !mod && "invisible")}>
            {mod === "⌘" ? "⌘K" : "Ctrl K"}
          </Kbd>
        </button>
      </div>
    </header>
  );
}
