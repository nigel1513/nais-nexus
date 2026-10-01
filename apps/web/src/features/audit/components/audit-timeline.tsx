"use client";
import { EmptyState, StatusBadge } from "@nais/ui";
import type { InfiniteData } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { flattenPages } from "@/shared/api/pagination";
import type { AuditEvent, Page } from "@/shared/api/types";
import { DateTime } from "@/shared/ui/date-text";
import { DelayedSkeleton, ErrorView, LoadMore } from "@/shared/ui/state-views";

type Q = {
  data?: InfiniteData<Page<AuditEvent>>;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => unknown;
};

export function AuditTimeline({ query }: { query: Q }) {
  const t = useTranslations();
  if (query.isPending) return <DelayedSkeleton lines={4} />;
  if (query.isError) return <ErrorView error={query.error} onRetry={() => void query.refetch()} />;
  const events = flattenPages(query.data);
  if (!events.length) return <EmptyState title={t("activity.empty")} />;
  return (
    <>
      <ol className="flex flex-col gap-3 border-l-2 border-border pl-4">
        {events.map((e) => (
          <li key={e.audit_event_id} className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              <DateTime value={e.occurred_at} />
            </span>
            <span className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{e.actor.display_name ?? t("activity.system")}</span>
              <span>{t(`enums.AuditAction.${e.action}`)}</span>
              <StatusBadge tone={e.result === "SUCCESS" ? "success" : "danger"} label={t(`activity.result.${e.result}`)} />
            </span>
          </li>
        ))}
      </ol>
      <LoadMore hasNextPage={query.hasNextPage} isFetchingNextPage={query.isFetchingNextPage} fetchNextPage={query.fetchNextPage} />
    </>
  );
}
