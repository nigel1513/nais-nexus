"use client";
import { cn, focusRing } from "@nais/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useDatasetActivity, type DatasetActivity } from "@/features/hub/api";
import { flattenPages } from "@/shared/api/pagination";
import { DateTime } from "@/shared/ui/date-text";
import { DelayedSkeleton, ErrorView, LoadMore } from "@/shared/ui/state-views";

const READINESS = ["PASS", "WARNING", "FAIL"] as const;
const isReadiness = (v: string): v is (typeof READINESS)[number] => (READINESS as readonly string[]).includes(v);

const linkCls = cn("rounded-xs font-medium text-fg underline-offset-4 hover:underline", focusRing);

/**
 * 이력: versions, policy and metadata changes, validation, project use, hub publication and discussion, newest first.
 * Project details are present only for projects I am in (the server blanks the rest).
 */
export function DatasetHistory({ datasetId, onOpenThread }: { datasetId: string; onOpenThread: (threadId: string) => void }) {
  const t = useTranslations();
  const activity = useDatasetActivity(datasetId);
  const rows = flattenPages(activity.data);
  if (activity.isPending) return <DelayedSkeleton lines={4} />;
  if (activity.isError) return <ErrorView error={activity.error} onRetry={() => void activity.refetch()} />;
  if (!rows.length) return <p className="border-y border-border px-3 py-4 text-small text-fg-muted">{t("data.card.history.empty")}</p>;

  const subject = (a: DatasetActivity): ReactNode => {
    switch (a.type) {
      case "VERSION_PUBLISHED":
        return a.ref_id && a.label ? (
          <Link href={`/commons/data/${datasetId}/versions/${a.ref_id}`} className={cn(linkCls, "font-mono text-mono")}>
            {a.label}
          </Link>
        ) : (
          a.label
        );
      case "READINESS_COMPLETED":
        if (!a.label) return null;
        return isReadiness(a.label) ? t("data.card.history.readiness", { status: t(`enums.ReadinessOverall.${a.label}`) }) : a.label;
      case "USED_IN_PROJECT":
        return a.project_id && a.label ? (
          <Link href={`/commons/projects/${a.project_id}`} className={linkCls}>
            {a.label}
          </Link>
        ) : (
          <span className="text-fg-muted">{t("data.card.history.otherProject")}</span>
        );
      case "DISCUSSION_STARTED":
        return a.ref_id && a.label ? (
          <button type="button" onClick={() => onOpenThread(a.ref_id!)} className={cn(linkCls, "text-left")}>
            {a.label}
          </button>
        ) : (
          a.label
        );
      default:
        return a.label;
    }
  };

  return (
    <>
      <ol aria-label={t("data.card.historyTitle")} className="flex flex-col divide-y divide-border border-y border-border text-small">
        {rows.map((a) => (
          <li key={a.activity_id} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4 gap-y-0.5 px-3 py-2.5 sm:grid-cols-[6.5rem_9rem_minmax(0,1fr)_auto] sm:items-baseline">
            <span className="num row-span-2 text-fg-muted sm:row-span-1">
              <DateTime value={a.occurred_at} dateOnly />
            </span>
            <span className="text-fg">{t(`enums.DatasetActivityType.${a.type}`)}</span>
            <span className="min-w-0 break-words sm:col-auto">{subject(a) ?? <span className="text-fg-muted">—</span>}</span>
            {a.actor_display_name ? <span className="hidden text-fg-muted sm:block">{a.actor_display_name}</span> : <span className="hidden sm:block" />}
          </li>
        ))}
      </ol>
      <LoadMore hasNextPage={activity.hasNextPage} isFetchingNextPage={activity.isFetchingNextPage} fetchNextPage={activity.fetchNextPage} />
    </>
  );
}
