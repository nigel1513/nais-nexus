"use client";
import { Sheet, SheetContent, SheetTitle, cn } from "@nais/ui";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState, type ReactNode } from "react";
import type { Me } from "@/shared/api/types";
import { BreadcrumbsProvider } from "./breadcrumbs";
import { CommandPaletteProvider } from "./command-palette";
import { useDestinations } from "./nav";
import { Sidebar, useSidebarCollapsed } from "./sidebar";
import { TopBar } from "./top-bar";

const DESKTOP = "(min-width: 768px)";

/** Content column: max 1200px, side padding 16 / 24 / 32px by width (spec §2.4). */
const contentClass = "mx-auto w-full max-w-[1200px] flex-1 px-4 py-6 md:px-6 xl:px-8";

/**
 * Spec §3 app shell: sidebar (240px, or a 64px rail) | top bar 48px over the content. Below 768px the sidebar lives
 * in a left sheet opened from the top bar.
 */
export function AppShell({ me, children }: { me: Me; children: ReactNode }) {
  const t = useTranslations();
  const pathname = usePathname();
  const destinations = useDestinations(me);
  const [collapsed, toggleCollapsed] = useSidebarCollapsed();
  const [sheetOpen, setSheetOpen] = useState(false);

  // Leaving the page or growing past the phone breakpoint closes the sheet.
  useEffect(() => setSheetOpen(false), [pathname]);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(DESKTOP);
    const onChange = () => mq.matches && setSheetOpen(false);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return (
    <BreadcrumbsProvider>
      <CommandPaletteProvider me={me}>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[var(--z-tooltip)] focus:rounded-sm focus:bg-bg-panel focus:px-3 focus:py-2 focus:text-body focus:shadow-popover"
        >
          {t("common.skipToContent")}
        </a>
        <div className="flex min-h-dvh">
          {/* The column runs the page's full height (border, background); the sidebar inside sticks to the viewport. */}
          <div className={cn("hidden shrink-0 border-r border-border bg-bg-subtle md:block", collapsed ? "w-16" : "w-60")}>
            <div className="sticky top-0 z-[var(--z-sidebar)] h-dvh">
              <Sidebar me={me} collapsed={collapsed} onToggle={toggleCollapsed} />
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <TopBar destinations={destinations} onOpenMenu={() => setSheetOpen(true)} />
            <main id="main" tabIndex={-1} className={cn(contentClass, "outline-none")}>
              {children}
            </main>
          </div>
        </div>
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="left" closeLabel={t("common.close")} className="bg-bg-subtle">
            <SheetTitle className="sr-only">{t("shell.menuTitle")}</SheetTitle>
            <Sidebar me={me} onNavigate={() => setSheetOpen(false)} />
          </SheetContent>
        </Sheet>
      </CommandPaletteProvider>
    </BreadcrumbsProvider>
  );
}

/** The empty frame while getMe loads, so nothing jumps when the shell appears. `children` is the loading status. */
export function AppShellFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh">
      <div aria-hidden="true" className="hidden w-60 shrink-0 border-r border-border bg-bg-subtle md:block" />
      <div className="flex min-w-0 flex-1 flex-col">
        <div aria-hidden="true" className="h-12 shrink-0 border-b border-border" />
        <div className={contentClass}>{children}</div>
      </div>
    </div>
  );
}
