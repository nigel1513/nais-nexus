"use client";
import { useTranslations } from "next-intl";
import type { Dataset } from "@/shared/api/types";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { useGetFilePreview } from "../api";
import { ProfileStatus } from "./column-view";
import { GatedNotice, isGated } from "./gated-notice";
import { PreviewTable } from "./preview-table";

/** Compact: the 100-row preview in a bounded frame with a sticky header. */
export function CompactView({ fileId, path, dataset }: { fileId: string; path: string; dataset: Dataset }) {
  const t = useTranslations();
  const q = useGetFilePreview(fileId);
  if (q.isPending) return <DelayedSkeleton lines={4} />;
  if (q.isError) return isGated(q.error) ? <GatedNotice dataset={dataset} /> : <ErrorView error={q.error} onRetry={() => void q.refetch()} />;
  const p = q.data;
  if (p.status !== "READY") return <ProfileStatus profile={{ file_id: p.file_id, path, status: p.status, columns: [] }} />;
  return (
    <div className="flex flex-col gap-2">
      <PreviewTable caption={t("data.explorer.previewTable", { path })} header={p.header} rows={p.rows} maxHeight={480} />
      {p.columns.length === 0 ? <p className="text-caption text-fg-muted">{t("data.explorer.distributionOmitted")}</p> : null}
      {p.rows_truncated ? <p className="text-caption text-fg-muted">{t("data.explorer.rowsTruncated")}</p> : null}
    </div>
  );
}
