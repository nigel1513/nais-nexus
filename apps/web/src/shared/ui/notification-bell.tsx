"use client";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger, buttonClass, cn, focusRing, notify, toneClass, type Tone } from "@nais/ui";
import { Ban, Bell, CircleCheck, CircleX, Clock, Database, Inbox, PencilLine, UserPlus, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useListNotifications, useMarkAllNotificationsRead, useMarkNotificationRead } from "@/features/notifications/api";
import { localizeUtcTimes } from "@/shared/lib/format";
import { safeInternalPath } from "@/shared/lib/links";
import type { AppNotification } from "@/shared/api/types";

/** Each notification type gets one icon and tone, so the list scans by kind before it is read. */
const KIND: Record<AppNotification["type"], readonly [LucideIcon, Tone]> = {
  PROJECT_INVITATION: [UserPlus, "accent"],
  ACCESS_SUBMITTED: [Inbox, "info"],
  ACCESS_APPROVED: [CircleCheck, "success"],
  ACCESS_REJECTED: [CircleX, "danger"],
  ACCESS_CHANGES_REQUESTED: [PencilLine, "warning"],
  ACCESS_EXPIRING: [Clock, "warning"],
  ACCESS_REVOKED: [Ban, "danger"],
  DATASET_PUBLISHED: [Database, "neutral"],
};

const RTF = new Intl.RelativeTimeFormat("ko", { numeric: "auto" });
/** "방금 전", "5분 전", "어제" … ; the absolute time stays in the title. */
function ago(iso: string, now = Date.now()): string {
  const s = Math.round((Date.parse(iso) - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return RTF.format(0, "second");
  if (abs < 3600) return RTF.format(Math.round(s / 60), "minute");
  if (abs < 86_400) return RTF.format(Math.round(s / 3600), "hour");
  if (abs < 30 * 86_400) return RTF.format(Math.round(s / 86_400), "day");
  return RTF.format(Math.round(s / (30 * 86_400)), "month");
}

/**
 * Top-bar bell (spec §3): 360px popover with the latest notifications; unread ones are bold with an indigo dot.
 * Clicking one marks it read and follows its link if that is an in-app route.
 */
export function NotificationBell() {
  const t = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { data } = useListNotifications({ limit: 20 }, { poll: true });
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const items = data?.items ?? [];
  const count = data?.unread_count ?? items.filter((n) => !n.read).length;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger aria-label={t("shell.notifications", { count })} className={buttonClass("ghost", "md", "relative w-8 px-0")}>
          <Bell aria-hidden="true" strokeWidth={1.75} />
          {count > 0 ? <span aria-hidden="true" className="absolute right-1.5 top-1.5 size-2 rounded-full border-2 border-bg bg-accent" /> : null}
        </PopoverTrigger>
        <PopoverContent align="end" className="flex w-90 flex-col p-0">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
            <PopoverTitle className="text-body font-semibold">{t("shell.notificationsTitle")}</PopoverTitle>
            {count > 0 ? <span className="num text-small text-fg-muted">{t("shell.unreadCount", { count })}</span> : null}
            {count > 0 ? (
              <button
                type="button"
                disabled={markAll.isPending}
                onClick={() => markAll.mutate()}
                className={buttonClass("ghost", "sm", "ml-auto")}
              >
                {t("shell.markAllRead")}
              </button>
            ) : null}
          </div>
          {items.length === 0 ? (
            <p className="px-4 py-6 text-small text-fg-muted">{t("shell.noNotifications")}</p>
          ) : (
            <ul className="max-h-[min(400px,60dvh)] overflow-y-auto p-1">
              {items.map((n) => (
                <li key={n.notification_id}>
                  <button
                    type="button"
                    className={cn("flex w-full cursor-pointer gap-3 rounded-sm px-3 py-2 text-left hover:bg-bg-hover", focusRing, "focus-visible:outline-offset-0")}
                    onClick={async () => {
                      setOpen(false);
                      if (!n.read) await markRead.mutateAsync(n.notification_id).catch(() => notify.error(t("shell.markReadFailed")));
                      // Only same-origin in-app routes are followed; anything else stays on the page.
                      const target = safeInternalPath(n.link);
                      if (target) router.push(target);
                    }}
                  >
                    <NotificationIcon type={n.type} />
                    <span className="min-w-0 flex-1">
                      <span className={cn("line-clamp-2 text-body", n.read ? "text-fg-muted" : "font-medium text-fg")}>{localizeUtcTimes(n.title)}</span>
                      <span className="mt-0.5 block text-caption font-normal text-fg-muted">
                        {t(`enums.NotificationType.${n.type}`)} ·{" "}
                        <time dateTime={n.created_at} title={new Date(n.created_at).toISOString()} className="num">
                          {ago(n.created_at)}
                        </time>
                      </span>
                    </span>
                    <span aria-hidden="true" className={cn("mt-2 size-2 shrink-0 rounded-full", n.read ? "bg-transparent" : "bg-accent")} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Link
            href="/settings#notifications"
            onClick={() => setOpen(false)}
            className={cn("flex h-10 shrink-0 items-center border-t border-border px-4 text-small text-fg-muted hover:text-fg", focusRing, "focus-visible:outline-offset-[-2px]")}
          >
            {t("shell.allNotifications")}
          </Link>
        </PopoverContent>
      </Popover>
      <span className="sr-only" aria-live="polite">
        {count > 0 ? t("shell.unreadAnnouncement", { count }) : ""}
      </span>
    </>
  );
}

function NotificationIcon({ type }: { type: AppNotification["type"] }) {
  const [Icon, tone] = KIND[type] ?? [Bell, "neutral"];
  return (
    <span aria-hidden="true" className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full", toneClass[tone])}>
      <Icon className="size-3.5" strokeWidth={1.75} />
    </span>
  );
}
