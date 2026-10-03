"use client";
import { cn, focusRing } from "@nais/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useDatasetProjects } from "@/features/hub/api";
import { DateTime } from "@/shared/ui/date-text";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";

/** 이 데이터를 쓴 프로젝트: projects I am in are listed; the others only add to a count (their names stay hidden). */
export function DatasetProjects({ datasetId }: { datasetId: string }) {
  const t = useTranslations();
  const projects = useDatasetProjects(datasetId);
  if (projects.isPending) return <DelayedSkeleton lines={2} />;
  if (projects.isError) return <ErrorView error={projects.error} onRetry={() => void projects.refetch()} />;
  const { items, hidden_count: hidden } = projects.data;
  if (!items.length && !hidden) return <p className="border-y border-border px-3 py-4 text-small text-fg-muted">{t("data.card.projects.empty")}</p>;
  return (
    <div className="flex flex-col gap-2">
      {items.length ? (
        <ul className="flex flex-col divide-y divide-border border-y border-border text-small">
          {items.map((p) => (
            <li key={p.project_id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2.5">
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <Link href={`/commons/projects/${p.project_id}`} className={cn("rounded-xs font-medium text-fg underline-offset-4 hover:underline", focusRing)}>
                  {p.name}
                </Link>
                <span className="text-fg-muted">{p.lead_organization_name}</span>
              </span>
              <span className="num shrink-0 text-fg-muted">
                {t("data.card.projects.added")} <DateTime value={p.input_added_at} dateOnly />
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {hidden ? <p className={cn("px-3 text-small text-fg-muted", !items.length && "border-y border-border py-4")}>{t("data.card.projects.hidden", { count: hidden })}</p> : null}
    </div>
  );
}
