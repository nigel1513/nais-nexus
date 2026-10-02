"use client";
import { EmptyState, GroupedList, type ListGroup } from "@nais/ui";
import type { InfiniteData } from "@tanstack/react-query";
import { History } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { flattenPages } from "@/shared/api/pagination";
import type { AuditEvent, Page } from "@/shared/api/types";
import { formatDate } from "@/shared/lib/format";
import { DelayedSkeleton, ErrorView, LoadMore } from "@/shared/ui/state-views";
import { ActivityEntry, ActivityRun, eventDay, sameRun, useTargetNames } from "./activity-entry";

const DAY_LABEL = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric", weekday: "short" });

/** One timeline row: a single event, or a run of identical consecutive events shown as one line. */
export type TimelineRow = { key: string; events: AuditEvent[] };

/** Events (newest first) split by Seoul calendar day, runs collapsed; headers say 오늘 / 어제 where it applies. */
export function useDayGroups(events: AuditEvent[]): ListGroup<TimelineRow>[] {
  const t = useTranslations();
  return useMemo(() => {
    const today = formatDate(new Date().toISOString());
    const yesterday = formatDate(new Date(Date.now() - 86_400_000).toISOString());
    const groups: ListGroup<TimelineRow>[] = [];
    for (const e of events) {
      const day = eventDay(e);
      let g = groups.at(-1);
      if (!g || g.key !== day) {
        g = { key: day, label: day, items: [] };
        groups.push(g);
      }
      const row = g.items.at(-1);
      if (row && sameRun(row.events[0]!, e)) row.events.push(e);
      else g.items.push({ key: e.audit_event_id, events: [e] });
    }
    const several = groups.length > 1;
    return groups.map((g) => {
      const relative = g.key === today ? t("activity.today") : g.key === yesterday ? t("activity.yesterday") : null;
      const full = DAY_LABEL.format(new Date(`${g.key}T12:00:00+09:00`));
      const count = g.items.reduce((n, r) => n + r.events.length, 0);
      return {
        ...g,
        label: (
          <>
            <span className="text-fg">{relative ?? full}</span>
            {relative ? <span>{full}</span> : null}
            {/* With a single day the result count above already says it. */}
            {several ? <span className="num ml-auto">{t("activity.dayCount", { count })}</span> : null}
          </>
        ),
      };
    });
  }, [events, t]);
}

/** Date-grouped audit timeline (also used on the project page). */
export function ActivityTimeline({ events, label, compact, headingLevel }: { events: AuditEvent[]; label: string; compact?: boolean; headingLevel?: 2 | 3 | 4 }) {
  const names = useTargetNames();
  const groups = useDayGroups(events);
  return (
    <GroupedList<TimelineRow>
      label={label}
      headingLevel={headingLevel}
      groups={groups}
      itemKey={(r) => r.key}
      renderItem={(r) =>
        r.events.length > 1 ? <ActivityRun events={r.events} names={names} compact={compact} /> : <ActivityEntry event={r.events[0]!} names={names} compact={compact} />
      }
    />
  );
}

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
  if (!events.length) return <EmptyState icon={History} title={t("activity.empty")} />;
  return (
    <>
      <ActivityTimeline events={events} label={t("activity.timelineLabel")} />
      <LoadMore hasNextPage={query.hasNextPage} isFetchingNextPage={query.isFetchingNextPage} fetchNextPage={query.fetchNextPage} />
    </>
  );
}
