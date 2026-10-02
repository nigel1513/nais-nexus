"use client";
import { useTranslations } from "next-intl";
import type { ColumnDistribution, Dataset } from "@/shared/api/types";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { useGetFilePreview } from "../api";
import { ProfileStatus } from "./column-view";
import { formatStat } from "./format-stat";
import { GatedNotice, isGated } from "./gated-notice";
import { Histogram } from "./histogram";
import { PreviewTable } from "./preview-table";

const PREVIEW_ROWS = 5;

function Dist({ col }: { col: ColumnDistribution }) {
  const t = useTranslations();
  if (col.kind === "numeric" && col.histogram?.length && col.min != null && col.max != null) {
    return (
      <>
        <Histogram name={col.name} min={col.min} max={col.max} bins={col.histogram} />
        <dl className="grid grid-cols-3 gap-2">
          {(
            [
              ["min", col.min],
              ["max", col.max],
              ["mean", col.mean],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-caption text-fg-muted">{t(`data.explorer.stat.${k}`)}</dt>
              <dd className="num truncate font-mono text-mono text-fg">{formatStat(v)}</dd>
            </div>
          ))}
        </dl>
      </>
    );
  }
  if (col.kind === "categorical" && col.top_values?.length) {
    const top = Math.max(1, ...col.top_values.map((v) => v.count));
    return (
      <ul aria-label={t("data.explorer.topValues")} className="flex flex-col gap-1.5 text-small">
        {col.top_values.map((v) => (
          <li key={v.value} className="grid grid-cols-[minmax(0,6rem)_1fr_auto] items-center gap-2">
            <span className="truncate font-mono text-mono text-fg" title={v.value}>
              {v.value}
            </span>
            <span aria-hidden="true" className="h-2 overflow-hidden rounded-xs bg-bg-hover">
              <span className="block h-full bg-chart-muted" style={{ width: `${(v.count / top) * 100}%` }} />
            </span>
            <span className="num text-caption text-fg-muted">{v.count.toLocaleString("ko-KR")}</span>
          </li>
        ))}
      </ul>
    );
  }
  return <p className="text-small text-fg-muted">{t("data.explorer.distributionUnsupported")}</p>;
}

/** Detail: one card per column (2 columns) with its distribution and stats, then the first rows. */
export function DetailView({ fileId, path, dataset }: { fileId: string; path: string; dataset: Dataset }) {
  const t = useTranslations();
  const q = useGetFilePreview(fileId);
  if (q.isPending) return <DelayedSkeleton lines={4} />;
  if (q.isError) return isGated(q.error) ? <GatedNotice dataset={dataset} /> : <ErrorView error={q.error} onRetry={() => void q.refetch()} />;
  const p = q.data;
  if (p.status !== "READY") return <ProfileStatus profile={{ file_id: p.file_id, path: "", status: p.status, columns: [] }} />;
  return (
    <div className="flex flex-col gap-4">
      {p.columns.length === 0 ? (
        <p className="text-small text-fg-muted">{t("data.explorer.distributionOmitted")}</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {p.columns.map((c) => (
            <li key={c.name} className="flex min-w-0 flex-col gap-2.5 rounded-md border border-border p-3">
              <p className="flex items-baseline justify-between gap-2">
                <span className="truncate font-mono text-mono font-medium text-fg">{c.name}</span>
                <span className="shrink-0 text-caption text-fg-muted">{c.kind}</span>
              </p>
              <Dist col={c} />
            </li>
          ))}
        </ul>
      )}
      {p.header.length && p.rows.length ? (
        <div className="flex flex-col gap-2">
          <p className="text-caption text-fg-muted">{t("data.explorer.previewHead", { count: Math.min(PREVIEW_ROWS, p.rows.length) })}</p>
          <PreviewTable caption={t("data.explorer.previewHead", { count: Math.min(PREVIEW_ROWS, p.rows.length) }) + ` — ${path}`} header={p.header} rows={p.rows.slice(0, PREVIEW_ROWS)} />
        </div>
      ) : null}
    </div>
  );
}
