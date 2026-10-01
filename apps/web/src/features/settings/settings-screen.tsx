"use client";
import { Button, Card, CardContent, CardHeader, CardTitle, EmptyState } from "@nais/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useListNotifications, useMarkAllNotificationsRead, useMarkNotificationRead } from "@/features/notifications/api";
import { LOCALE_COOKIE } from "@/shared/config";
import { safeInternalPath } from "@/shared/lib/links";
import { useMeData } from "@/shared/hooks/use-me";
import { DateTime } from "@/shared/ui/date-text";
import { PageHeader } from "@/shared/ui/page-header";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";

export function SettingsScreen() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const me = useMeData();
  const notifications = useListNotifications({ limit: 50 });
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const items = notifications.data?.items ?? [];

  const setLocale = (value: "ko" | "en") => {
    document.cookie = `${LOCALE_COOKIE}=${value}; path=/; max-age=31536000; SameSite=Lax`;
    router.refresh();
  };

  return (
    <>
      <PageHeader title={t("settings.title")} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("settings.profile")}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
              <dt className="text-muted-foreground">{t("settings.name")}</dt>
              <dd>{me.display_name}</dd>
              <dt className="text-muted-foreground">{t("settings.email")}</dt>
              <dd className="break-all">{me.email}</dd>
              <dt className="text-muted-foreground">{t("settings.organization")}</dt>
              <dd>{me.organization.name}</dd>
              <dt className="text-muted-foreground">{t("settings.roles")}</dt>
              <dd>{[...me.org_roles.map((r) => t(`enums.OrgRole.${r}`)), ...me.platform_roles.map((r) => t(`enums.PlatformRole.${r}`))].join(", ") || "—"}</dd>
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">{t("settings.profileHint")}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("settings.language")}</CardTitle>
          </CardHeader>
          <CardContent>
            <fieldset className="flex flex-col gap-2">
              <legend className="sr-only">{t("settings.language")}</legend>
              {(["ko", "en"] as const).map((l) => (
                <label key={l} className="flex items-center gap-2 text-sm">
                  <input type="radio" name="locale" className="h-5 w-5" checked={locale === l} onChange={() => setLocale(l)} />
                  {l === "ko" ? "한국어" : "English"}
                </label>
              ))}
            </fieldset>
          </CardContent>
        </Card>
        <Card className="lg:col-span-2" id="notifications">
          <CardHeader>
            <CardTitle>{t("settings.notifications")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div>
              <Button size="sm" variant="outline" disabled={markAll.isPending} onClick={() => markAll.mutate()}>
                {t("shell.markAllRead")}
              </Button>
            </div>
            {notifications.isPending ? (
              <DelayedSkeleton lines={3} />
            ) : notifications.isError ? (
              <ErrorView error={notifications.error} onRetry={() => void notifications.refetch()} />
            ) : items.length === 0 ? (
              <EmptyState title={t("shell.noNotifications")} />
            ) : (
              <ul aria-label={t("settings.notificationList")} className="flex flex-col divide-y divide-border">
                {items.map((n) => {
                  const link = safeInternalPath(n.link);
                  return (
                    <li key={n.notification_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <div className="min-w-0">
                        <p className={n.read ? "text-muted-foreground" : "font-medium"}>
                          {n.read ? null : <span className="sr-only">{t("settings.unread")} </span>}
                          {n.title}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t(`enums.NotificationType.${n.type}`)} · <DateTime value={n.created_at} />
                        </p>
                      </div>
                      <div className="flex gap-2">
                        {link ? (
                          <Link href={link} className="text-sm underline">
                            {t("settings.open")}
                          </Link>
                        ) : null}
                        {!n.read ? (
                          <Button size="sm" variant="ghost" disabled={markRead.isPending} onClick={() => markRead.mutate(n.notification_id)}>
                            {t("settings.markRead")}
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
