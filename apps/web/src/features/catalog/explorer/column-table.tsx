"use client";
import { Button } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { useGetDatasetVersion, useGetFileProfiles } from "../api";
import { isTabular } from "../lib/tabular";

const PAGE = 20;

export function ColumnTable({ versionId }: { versionId: string }) {
  const t = useTranslations();
  const version = useGetDatasetVersion(versionId);
  const [shown, setShown] = useState(PAGE);
  const tabular = (version.data?.files ?? []).filter((f) => f.status === "VERIFIED" && isTabular(f.path));
  const visible = tabular.slice(0, shown);
  const profiles = useGetFileProfiles(visible.map((f) => f.file_id));
  if (version.isPending) return <DelayedSkeleton lines={3} />;
  if (version.isError) return <ErrorView error={version.error} onRetry={() => void version.refetch()} />;
  if (tabular.length === 0) return <p className="text-sm text-muted-foreground">{t("data.explorer.empty")}</p>;
  return (
    <div>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrollable region must be keyboard reachable */}
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={t("data.explorer.columnTable")}>
        <table aria-label={t("data.explorer.columnTable")} className="w-full text-left text-sm">
          <thead>
            <tr className="border-b">
              {(["file", "column", "type", "unit", "description"] as const).map((c) => (
                <th key={c} scope="col" className="px-2 py-1 font-medium">{t(`data.explorer.col.${c}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((f, i) => {
              const q = profiles[i];
              const p = q?.data;
              if (p?.status === "READY") {
                return p.columns.map((c) => (
                  <tr key={`${f.file_id}:${c.name}`} className="border-b align-top">
                    <td className="px-2 py-1 font-mono text-xs">{f.path}</td>
                    <td className="px-2 py-1 font-mono">{c.name}</td>
                    <td className="px-2 py-1">{c.type}</td>
                    <td className="px-2 py-1">{c.unit ?? "—"}</td>
                    <td className="px-2 py-1">{c.description ?? "—"}</td>
                  </tr>
                ));
              }
              const note = q?.isError ? t("data.explorer.statusShort.FAILED") : p ? t(`data.explorer.statusShort.${p.status}`) : "…";
              return (
                <tr key={f.file_id} className="border-b">
                  <td className="px-2 py-1 font-mono text-xs">{f.path}</td>
                  <td colSpan={4} className="px-2 py-1 text-muted-foreground">{note}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {tabular.length > shown ? (
        <Button variant="outline" size="sm" className="mt-2" onClick={() => setShown((n) => n + PAGE)}>
          {t("data.explorer.showMore")}
        </Button>
      ) : null}
    </div>
  );
}
