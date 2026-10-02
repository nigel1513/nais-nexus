"use client";
import { Avatar, Badge, Button, buttonClass, cn, EmptyState, Input, Label, Radio, RadioGroup } from "@nais/ui";
import { Lock, Monitor, Moon, Sun } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useUpdateMe } from "@/features/organizations/api";
import { useListNotifications, useMarkAllNotificationsRead, useMarkNotificationRead } from "@/features/notifications/api";
import { LOCALE_COOKIE } from "@/shared/config";
import { safeInternalPath } from "@/shared/lib/links";
import { useMeData } from "@/shared/hooks/use-me";
import { DateTime } from "@/shared/ui/date-text";
import { notify } from "@/shared/ui/toast";
import { useErrorText } from "@/shared/api/use-error-text";
import { asApiError } from "@/shared/api/errors";
import { PageHeader } from "@/shared/ui/page-header";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { useThemeChoice, type ThemeChoice } from "@/shared/ui/theme";
import { RoleBadges } from "./components/member-row";
import { SettingsLayout, SettingsSectionCard } from "./components/settings-layout";

const NTIS_PATTERN = /^[0-9]{8}$/;
const icon = { "aria-hidden": true, strokeWidth: 1.75 } as const;

/** Option tile for a RadioGroup: the whole tile is the label; the chosen one gets the primary border. */
const tileClass =
  "h-10 rounded-sm border border-border bg-bg-panel px-3 hover:bg-bg-hover has-[[data-checked]]:border-border-strong has-[[data-checked]]:bg-bg-active has-[[data-checked]]:hover:bg-bg-active [&_svg]:size-4 [&_svg]:text-fg-muted";

function ProfileSection() {
  const t = useTranslations();
  const me = useMeData();
  const hasRoles = me.org_roles.length > 0 || me.platform_roles.length > 0;
  const rows: [string, ReactNode][] = [
    [t("settings.organization"), me.organization.name],
    [
      t("settings.roles"),
      hasRoles ? (
        <span className="flex flex-wrap gap-1">
          <RoleBadges roles={me.org_roles} />
          {me.platform_roles.map((r) => (
            <Badge key={r} tone="warning">
              {t(`enums.PlatformRole.${r}`)}
            </Badge>
          ))}
        </span>
      ) : (
        <span className="text-fg-muted">{t("settings.noRoles")}</span>
      ),
    ],
  ];
  return (
    <SettingsSectionCard
      id="profile"
      title={t("settings.profile")}
      description={t("settings.profileDescription")}
      footer={
        <p className="flex items-center gap-1.5 text-small text-fg-muted">
          <Lock {...icon} className="size-3.5 shrink-0" />
          {t("settings.profileHint")}
        </p>
      }
    >
      <div className="flex items-center gap-3 pb-4">
        <Avatar name={me.display_name} size={32} decorative />
        <div className="min-w-0">
          <p className="truncate text-body font-medium text-fg">{me.display_name}</p>
          <p className="truncate text-small text-fg-muted">{me.email}</p>
        </div>
      </div>
      <dl className="divide-y divide-border border-t border-border">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3 py-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
            <dt className="text-small text-fg-muted">{label}</dt>
            <dd className="min-w-0 break-words text-body text-fg">{value}</dd>
          </div>
        ))}
      </dl>
    </SettingsSectionCard>
  );
}

function NtisSection({ current }: { current: string | null }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const update = useUpdateMe();
  const [value, setValue] = useState(current ?? "");
  const [error, setError] = useState<string | null>(null);

  const send = (next: string | null) =>
    update.mutate(next, {
      onSuccess: () => {
        setError(null);
        if (next === null) setValue("");
        notify.success(t("settings.ntis.saved"));
      },
      onError: (e) => {
        const err = asApiError(e);
        if (err.code === "CONFLICT") setError(t("settings.ntis.duplicate"));
        else if (err.code === "VALIDATION_FAILED") setError(t("settings.ntis.format"));
        else notify.error(errorText(e));
      },
    });

  return (
    <form
      noValidate
      className="scroll-mt-16"
      id="researcher-number"
      onSubmit={(e) => {
        e.preventDefault();
        const v = value.trim();
        if (!NTIS_PATTERN.test(v)) {
          setError(t("settings.ntis.format"));
          return;
        }
        send(v);
      }}
    >
      <SettingsSectionCard
        title={t("settings.ntis.title")}
        description={t("settings.ntis.description")}
        actions={
          current ? (
            <Badge tone="success" dot>
              {t("settings.ntis.registered")}
            </Badge>
          ) : (
            <Badge dot>{t("settings.ntis.notRegistered")}</Badge>
          )
        }
        footer={
          <>
            <p id="ntis-hint" className="text-small text-fg-muted">
              {t("settings.ntis.hint")}
            </p>
            <div className="ml-auto flex items-center gap-2">
              {current ? (
                <Button size="sm" type="button" variant="ghost" disabled={update.isPending} onClick={() => send(null)}>
                  {t("settings.ntis.remove")}
                </Button>
              ) : null}
              <Button variant="primary" size="sm" type="submit" disabled={update.isPending}>
                {t("settings.ntis.save")}
              </Button>
            </div>
          </>
        }
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ntis-number">{t("settings.ntis.label")}</Label>
          <Input
            id="ntis-number"
            className="num max-w-40 font-mono"
            inputMode="numeric"
            autoComplete="off"
            pattern="[0-9]{8}"
            maxLength={8}
            placeholder="00000000"
            value={value}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "ntis-hint ntis-error" : "ntis-hint"}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
          />
          {error ? (
            <p id="ntis-error" role="alert" className="text-small text-danger">
              {error}
            </p>
          ) : null}
        </div>
      </SettingsSectionCard>
    </form>
  );
}

const noopSubscribe = () => () => {};
/** False during SSR and hydration, true after: the stored theme is only known on the client. */
function useHydrated() {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

function ThemeSection() {
  const t = useTranslations();
  const { choice, setChoice } = useThemeChoice();
  const hydrated = useHydrated();
  const options: { value: ThemeChoice; label: string; icon: ReactNode }[] = [
    { value: "system", label: t("shell.themeSystem"), icon: <Monitor {...icon} /> },
    { value: "light", label: t("shell.themeLight"), icon: <Sun {...icon} /> },
    { value: "dark", label: t("shell.themeDark"), icon: <Moon {...icon} /> },
  ];
  return (
    <SettingsSectionCard id="theme" title={t("settings.theme")} description={t("settings.themeDescription")}>
      <RadioGroup
        aria-label={t("settings.theme")}
        orientation="horizontal"
        value={hydrated ? choice : "system"}
        onValueChange={(v) => setChoice(v as ThemeChoice)}
        className="grid grid-cols-1 gap-2 sm:grid-cols-3"
      >
        {options.map((o) => (
          <Radio
            key={o.value}
            value={o.value}
            className={tileClass}
            label={
              <span className="flex items-center gap-2">
                {o.icon}
                {o.label}
              </span>
            }
          />
        ))}
      </RadioGroup>
    </SettingsSectionCard>
  );
}

function LanguageSection() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const setLocale = (value: string) => {
    document.cookie = `${LOCALE_COOKIE}=${value}; path=/; max-age=31536000; SameSite=Lax`;
    router.refresh();
  };
  return (
    <SettingsSectionCard id="language" title={t("settings.language")} description={t("settings.languageDescription")}>
      <RadioGroup
        aria-label={t("settings.language")}
        orientation="horizontal"
        value={locale}
        onValueChange={setLocale}
        className="grid grid-cols-2 gap-2"
      >
        <Radio value="ko" label={<span lang="ko">한국어</span>} className={tileClass} />
        <Radio value="en" label={<span lang="en">English</span>} className={tileClass} />
      </RadioGroup>
    </SettingsSectionCard>
  );
}

function NotificationsSection() {
  const t = useTranslations();
  const notifications = useListNotifications({ limit: 50 });
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const items = notifications.data?.items ?? [];
  const unread = items.filter((n) => !n.read).length;

  return (
    <SettingsSectionCard
      id="notifications"
      title={t("settings.notifications")}
      description={t("settings.notificationsDescription")}
      actions={
        <Button size="sm" variant="secondary" disabled={markAll.isPending} onClick={() => markAll.mutate()}>
          {t("shell.markAllRead")}
        </Button>
      }
      bodyClassName="p-0 pt-4"
    >
      {notifications.isPending ? (
        <div className="px-5 pb-5">
          <DelayedSkeleton lines={3} />
        </div>
      ) : notifications.isError ? (
        <div className="px-5 pb-5">
          <ErrorView error={notifications.error} onRetry={() => void notifications.refetch()} />
        </div>
      ) : items.length === 0 ? (
        <div className="border-t border-border px-5 py-6">
          <EmptyState title={t("shell.noNotifications")} />
        </div>
      ) : (
        <>
          <p className="px-5 pb-2 text-caption text-fg-muted">
            <span className="num">{t("settings.notificationSummary", { total: items.length, unread })}</span>
          </p>
          <ul aria-label={t("settings.notificationList")} className="divide-y divide-border border-t border-border">
            {items.map((n) => {
              const link = safeInternalPath(n.link);
              return (
                <li key={n.notification_id} className="flex flex-col gap-2 py-3 pl-5 pr-4 sm:flex-row sm:items-center sm:gap-3">
                  <span aria-hidden="true" className={cn("hidden size-1.5 shrink-0 rounded-full sm:block", n.read ? "invisible" : "bg-accent")} />
                  <div className="min-w-0 flex-1">
                    <p className={cn("break-words text-body", n.read ? "text-fg-muted" : "font-medium text-fg")}>
                      {n.read ? null : <span className="sr-only">{t("settings.unread")} </span>}
                      {n.title}
                    </p>
                    <p className="mt-0.5 text-caption text-fg-muted">
                      {t(`enums.NotificationType.${n.type}`)} ·{" "}
                      <span className="num">
                        <DateTime value={n.created_at} />
                      </span>
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {!n.read ? (
                      <Button size="sm" variant="ghost" disabled={markRead.isPending} onClick={() => markRead.mutate(n.notification_id)}>
                        {t("settings.markRead")}
                      </Button>
                    ) : null}
                    {link ? (
                      <Link href={link} className={buttonClass("secondary", "sm")}>
                        {t("settings.open")}
                      </Link>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </SettingsSectionCard>
  );
}

export function SettingsScreen() {
  const t = useTranslations();
  const me = useMeData();
  return (
    <SettingsLayout page="account" header={<PageHeader title={t("settings.title")} description={t("settings.description")} />}>
      <ProfileSection />
      <NtisSection key={me.national_researcher_number ?? ""} current={me.national_researcher_number ?? null} />
      <ThemeSection />
      <LanguageSection />
      <NotificationsSection />
    </SettingsLayout>
  );
}
