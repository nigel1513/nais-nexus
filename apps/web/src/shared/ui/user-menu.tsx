"use client";
import { Avatar, Menu, cn, focusRing } from "@nais/ui";
import { ChevronsUpDown, LogOut, Monitor, Moon, Settings, Sun } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useSignOut } from "@/features/auth/components/sign-out-button";
import type { Me } from "@/shared/api/types";
import { useThemeChoice, type ThemeChoice } from "./theme";

const icon = { "aria-hidden": true, strokeWidth: 1.75 } as const;

/** "Institute A · 데이터 관리자": where the user works and what they may do there (spec §3: shown, not switchable). */
function useAffiliation(me: Me): string {
  const t = useTranslations();
  const roles = me.org_roles.map((r) => t(`enums.OrgRole.${r}`));
  return [me.organization.name, ...roles].join(" · ");
}

/** Sidebar footer: who is signed in. Opens upward with settings, theme and sign-out. `compact` = avatar only (icon rail). */
export function UserMenu({ me, compact = false }: { me: Me; compact?: boolean }) {
  const t = useTranslations();
  const affiliation = useAffiliation(me);
  const { choice, setChoice } = useThemeChoice();
  const signOut = useSignOut();

  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(
          "flex w-full cursor-pointer select-none items-center gap-2 rounded-sm text-left hover:bg-bg-hover data-[popup-open]:bg-bg-hover",
          compact ? "size-10 justify-center" : "h-11 px-2",
          focusRing,
        )}
      >
        <Avatar name={me.display_name} size={compact ? 24 : 32} decorative />
        <span className={compact ? "sr-only" : "min-w-0 flex-1"}>
          <span className="block truncate text-small font-medium text-fg">{me.display_name}</span>
          <span className="block truncate text-caption text-fg-muted">{affiliation}</span>
        </span>
        <span className="sr-only">{t("shell.userMenu")}</span>
        {compact ? null : <ChevronsUpDown {...icon} className="size-4 shrink-0 text-fg-muted" />}
      </Menu.Trigger>
      <Menu.Content side="top" align="start" sideOffset={4} className="w-64">
        <div className="px-2 pb-2 pt-1.5">
          <p className="truncate text-body font-medium text-fg">{me.display_name}</p>
          <p className="truncate text-small text-fg-muted">{me.email}</p>
          <p className="mt-1 truncate text-caption text-fg-muted">{affiliation}</p>
        </div>
        <Menu.Separator />
        <Menu.LinkItem render={<Link href="/settings" />} icon={<Settings {...icon} />}>
          {t("nav.settings")}
        </Menu.LinkItem>
        <Menu.Separator />
        <Menu.Group>
          <Menu.Label>{t("shell.theme")}</Menu.Label>
          <Menu.RadioGroup value={choice} onValueChange={(v) => setChoice(v as ThemeChoice)}>
            <Menu.RadioItem value="system" icon={<Monitor {...icon} />}>
              {t("shell.themeSystem")}
            </Menu.RadioItem>
            <Menu.RadioItem value="light" icon={<Sun {...icon} />}>
              {t("shell.themeLight")}
            </Menu.RadioItem>
            <Menu.RadioItem value="dark" icon={<Moon {...icon} />}>
              {t("shell.themeDark")}
            </Menu.RadioItem>
          </Menu.RadioGroup>
        </Menu.Group>
        <Menu.Separator />
        <Menu.Item icon={<LogOut {...icon} />} onClick={signOut}>
          {t("auth.signOut")}
        </Menu.Item>
      </Menu.Content>
    </Menu.Root>
  );
}
