"use client";
import { Button, buttonClass } from "@nais/ui";
import { Bell } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useListNotifications, useMarkAllNotificationsRead, useMarkNotificationRead } from "@/features/notifications/api";
import { useOutsideDismiss } from "@/shared/hooks/use-dismiss";
import { safeInternalPath } from "@/shared/lib/links";
import { DateTime } from "./date-text";
import { useToast } from "./toast";

export function NotificationBell() {
  const t = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const close = useCallback(() => setOpen(false), []);
  useOutsideDismiss(open, rootRef, close);
  const { data } = useListNotifications({ unread_only: true }, { poll: true });
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const items = data?.items ?? [];
  const count = data?.unread_count ?? items.length;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <Button
        ref={buttonRef}
        variant="ghost"
        size="icon"
        className="relative"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t("shell.notifications", { count })}
        onClick={() => setOpen((o) => !o)}
      >
        <Bell aria-hidden="true" className="h-5 w-5" />
        {count > 0 ? (
          <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 rounded-full bg-destructive px-1.5 text-xs text-destructive-foreground">
            {count > 99 ? "99+" : count}
          </span>
        ) : null}
      </Button>
      {open ? (
        <div id={panelId} className="absolute right-0 z-40 mt-1 w-80 max-w-[calc(100vw-2rem)] rounded-md border border-border bg-background p-2 shadow-lg">
          <div className="flex items-center justify-between px-2 py-1">
            <p className="font-medium">{t("shell.notificationsTitle")}</p>
            {count > 0 ? (
              <Button size="sm" variant="link" disabled={markAll.isPending} onClick={() => markAll.mutate()}>
                {t("shell.markAllRead")}
              </Button>
            ) : null}
          </div>
          {items.length === 0 ? (
            <p className="px-2 py-4 text-sm text-muted-foreground">{t("shell.noNotifications")}</p>
          ) : (
            <ul className="max-h-80 overflow-y-auto">
              {items.map((n) => (
                <li key={n.notification_id}>
                  <button
                    type="button"
                    className="w-full rounded px-2 py-2 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                    onClick={async () => {
                      setOpen(false);
                      await markRead.mutateAsync(n.notification_id).catch(() => toast(t("shell.markReadFailed"), "error"));
                      // Only same-origin in-app routes are followed; anything else stays on the page.
                      const target = safeInternalPath(n.link);
                      if (target) router.push(target);
                    }}
                  >
                    <span className="block font-medium">{n.title}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t(`enums.NotificationType.${n.type}`)} · <DateTime value={n.created_at} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Link href="/settings#notifications" className={buttonClass("link", "sm", "w-full")} onClick={() => setOpen(false)}>
            {t("shell.allNotifications")}
          </Link>
        </div>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {count > 0 ? t("shell.unreadAnnouncement", { count }) : ""}
      </span>
    </div>
  );
}
