"use client";
import { Menu, Tooltip, cn, focusRing } from "@nais/ui";
import { ChevronsUpDown, Globe } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ComponentProps } from "react";
import { COPYRIGHT, EXTERNAL_LINK, familySites, parentSite } from "@/shared/family-sites";

const icon = { "aria-hidden": true, strokeWidth: 1.75 } as const;

/** The "↗" that marks a link leaving the portal; the new tab is announced in words, not by the glyph. */
function External() {
  const t = useTranslations("family");
  return (
    <>
      <span aria-hidden="true" className="font-mono text-[0.85em]">
        ↗
      </span>
      <span className="sr-only"> ({t("newTab")})</span>
    </>
  );
}

/** An anchor that opens in a new tab without window.opener; also the element a menu item renders as. */
function NewTabLink({ children, ...props }: ComponentProps<"a">) {
  return (
    <a {...props} {...EXTERNAL_LINK}>
      {children}
    </a>
  );
}

/** "국가과학AI연구센터 홈 ↗": the parent organisation's site in a new tab. */
export function ParentHomeLink({ className }: { className?: string }) {
  const t = useTranslations("family");
  const site = parentSite();
  return (
    <NewTabLink href={site.href} className={className}>
      {t("parentHome", { name: site.label })} <External />
    </NewTabLink>
  );
}

type Variant = "field" | "icon" | "landing";

const triggerClass: Record<Variant, string> = {
  // Sidebar: a select-like row (label left, chevrons right) on the panel colour.
  field:
    "flex h-8 w-full items-center justify-between gap-2 rounded-sm border border-border bg-bg-panel px-2 text-small text-fg-muted hover:border-border-strong hover:text-fg data-[popup-open]:border-border-strong data-[popup-open]:text-fg",
  // Icon rail: same footprint as the rail's other buttons.
  icon: "flex size-8 items-center justify-center rounded-sm text-fg-muted hover:bg-bg-hover hover:text-fg data-[popup-open]:bg-bg-hover data-[popup-open]:text-fg",
  // Public footer: an outlined control in the landing's type.
  landing:
    "inline-flex h-8 min-w-40 items-center justify-between gap-3 rounded-sm border border-border bg-bg-panel pl-3 pr-2 text-[13px] text-fg hover:border-border-strong data-[popup-open]:border-border-strong",
};

/**
 * 패밀리사이트: a menu of FAMILY_SITES, each opening in a new tab. A menu rather than a native select, because a
 * select that navigates on change fires while a keyboard user is still moving through the options.
 */
export function FamilySiteMenu({ variant = "field", className }: { variant?: Variant; className?: string }) {
  const t = useTranslations("family");
  const sites = familySites();
  const trigger = (
    <Menu.Trigger className={cn("cursor-pointer select-none", triggerClass[variant], focusRing, className)}>
      {variant === "icon" ? (
        <>
          <Globe {...icon} className="size-4" />
          <span className="sr-only">{t("label")}</span>
        </>
      ) : (
        <>
          <span className="truncate">{t("label")}</span>
          <ChevronsUpDown {...icon} className="size-3.5 shrink-0 text-fg-muted" />
        </>
      )}
    </Menu.Trigger>
  );
  return (
    <Menu.Root>
      {variant === "icon" ? (
        <Tooltip content={t("label")} side="right">
          {trigger}
        </Tooltip>
      ) : (
        trigger
      )}
      <Menu.Content
        side={variant === "icon" ? "right" : "top"}
        align={variant === "landing" ? "end" : "start"}
        sideOffset={4}
        className={variant === "icon" ? "min-w-56" : "w-[var(--anchor-width)] min-w-48"}
      >
        <Menu.Group>
          <Menu.Label>{t("label")}</Menu.Label>
          {sites.map((site) => (
            <Menu.LinkItem key={site.id} render={<NewTabLink href={site.href} />}>
              {site.label} <External />
            </Menu.LinkItem>
          ))}
        </Menu.Group>
        {variant === "icon" ? <p className="border-t border-border px-2 pb-1 pt-2 text-micro text-fg-muted">{COPYRIGHT}</p> : null}
      </Menu.Content>
    </Menu.Root>
  );
}

/** Sidebar foot, above the user menu: parent home link, family sites, copyright. The icon rail keeps only the menu. */
export function SidebarFamilyLinks({ compact }: { compact: boolean }) {
  if (compact) {
    return (
      <div className="flex shrink-0 justify-center pb-2">
        <FamilySiteMenu variant="icon" />
      </div>
    );
  }
  return (
    <div className="flex shrink-0 flex-col gap-1.5 px-2 pb-3">
      <ParentHomeLink
        className={cn(
          "flex h-7 items-center gap-1 self-start rounded-sm px-2 text-caption text-fg-muted hover:bg-bg-hover hover:text-fg",
          focusRing,
        )}
      />
      <FamilySiteMenu variant="field" />
      <p className="px-2 pt-0.5 text-micro text-fg-muted">{COPYRIGHT}</p>
    </div>
  );
}
