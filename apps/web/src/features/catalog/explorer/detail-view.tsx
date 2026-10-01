"use client";
import { useTranslations } from "next-intl";
import type { ColumnDistribution, Dataset } from "@/shared/api/types";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { useGetFilePreview } from "../api";
import { GatedNotice, isGated } from "./gated-notice";
import { Histogram } from "./histogram";
import { ProfileStatus } from "./column-view";

function Dist({ col }: { col: ColumnDistribution }) {
  const t = useTranslations();
  if (col.kind === "numeric" && col.histogram?.length && col.min != null && col.max != null) {
    return (
      <>
        <Histogram name={col.name} min={col.min} max={col.max} bins={col.histogram} />
        <p className="text-xs text-muted-foreground">{t("data.explorer.stats", { min: col.min, max: col.max, mean: col.mean ?? "—" })}</p>
      </>
    );
  }
  if (col.kind === "categorical" && col.top_values?.length) {
    const top = Math.max(1, ...col.top_values.map((v) => v.count));
    return (
      <ul className="flex flex-col gap-1 text-xs">
        {col.top_values.map((v) => (
          <li key={v.value} className="grid grid-cols-[6rem_1fr_auto] items-center gap-2">
            <span className="truncate">{v.value}</span>
            <span aria-hidden="true" className="h-2 rounded bg-primary" style={{ width: `${(v.count / top) * 100}%` }} />
            <span>{v.count}</span>
          </li>
        ))}
      </ul>
    );
  }
  return <p className="text-xs text-muted-foreground">{t("data.explorer.distributionUnsupported")}</p>;
}

export function DetailView({ fileId, dataset }: { fileId: string; dataset: Dataset }) {
  const t = useTranslations();
  const q = useGetFilePreview(fileId);
  if (q.isPending) return <DelayedSkeleton lines={4} />;
  if (q.isError) return isGated(q.error) ? <GatedNotice dataset={dataset} /> : <ErrorView error={q.error} onRetry={() => void q.refetch()} />;
  const p = q.data;
  if (p.status !== "READY") return <ProfileStatus profile={{ file_id: p.file_id, path: "", status: p.status, columns: [] }} />;
  if (p.columns.length === 0) return <p className="text-sm text-muted-foreground">{t("data.explorer.distributionOmitted")}</p>;
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {p.columns.map((c) => (
        <li key={c.name} className="rounded-md border p-3">
          <p className="mb-2 text-sm font-medium">
            <span className="font-mono">{c.name}</span> <span className="text-xs text-muted-foreground">{c.kind}</span>
          </p>
          <Dist col={c} />
        </li>
      ))}
    </ul>
  );
}
