"use client";
import { useTranslations } from "next-intl";
import type { Dataset } from "@/shared/api/types";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { useGetFilePreview } from "../api";
import { ProfileStatus } from "./column-view";
import { GatedNotice, isGated } from "./gated-notice";

export function CompactView({ fileId, path, dataset }: { fileId: string; path: string; dataset: Dataset }) {
  const t = useTranslations();
  const q = useGetFilePreview(fileId);
  if (q.isPending) return <DelayedSkeleton lines={4} />;
  if (q.isError) return isGated(q.error) ? <GatedNotice dataset={dataset} /> : <ErrorView error={q.error} onRetry={() => void q.refetch()} />;
  const p = q.data;
  if (p.status !== "READY") return <ProfileStatus profile={{ file_id: p.file_id, path, status: p.status, columns: [] }} />;
  return (
    <div>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrollable region must be keyboard reachable */}
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={t("data.explorer.previewRegion")}>
        <table aria-label={t("data.explorer.previewTable", { path })} className="w-full text-left text-xs">
          <thead>
            <tr className="border-b">
              {p.header.map((h, i) => (
                <th key={i} scope="col" className="whitespace-nowrap px-2 py-1 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {p.rows.map((r, i) => (
              <tr key={i} className="border-b">
                {r.map((cell, j) => (
                  <td key={j} className="whitespace-nowrap px-2 py-1">
                    {cell === null ? <span className="text-muted-foreground">—</span> : cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {p.columns.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">{t("data.explorer.distributionOmitted")}</p> : null}
      {p.rows_truncated ? <p className="mt-2 text-xs text-muted-foreground">{t("data.explorer.rowsTruncated")}</p> : null}
    </div>
  );
}
