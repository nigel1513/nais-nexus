"use client";
import { EmptyState } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { Dataset } from "@/shared/api/types";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { useGetDatasetVersion } from "../api";
import { isTabular } from "../lib/tabular";
import { ColumnView } from "./column-view";
import { CompactView } from "./compact-view";
import { DetailView } from "./detail-view";
import { FileTree } from "./file-tree";

type View = "detail" | "compact" | "column";

export function DataExplorer({ dataset, versionId }: { dataset: Dataset; versionId: string }) {
  const t = useTranslations();
  const version = useGetDatasetVersion(versionId);
  const [fileId, setFileId] = useState<string | undefined>();
  const [view, setView] = useState<View>("detail");
  if (version.isPending) return <DelayedSkeleton lines={3} />;
  if (version.isError) return <ErrorView error={version.error} onRetry={() => void version.refetch()} />;
  const files = version.data.files.filter((f) => f.status === "VERIFIED");
  const current = files.find((f) => f.file_id === fileId) ?? files.find((f) => isTabular(f.path)) ?? files[0];
  return (
    <div className="grid gap-4 md:grid-cols-[16rem_minmax(0,1fr)]">
      {files.length === 0 ? (
        <div className="md:col-span-2">
          <EmptyState title={t("data.explorer.noFiles")} />
        </div>
      ) : (
        <>
          <FileTree files={files} currentId={current?.file_id} onSelect={setFileId} />
          <div className="min-w-0">
            <fieldset className="mb-3 flex gap-4">
              <legend className="sr-only">{t("data.explorer.view")}</legend>
              {(["detail", "compact", "column"] as const).map((v) => (
                <label key={v} className="flex items-center gap-1 text-sm">
                  <input type="radio" name="explorer-view" checked={view === v} onChange={() => setView(v)} />
                  {t(`data.explorer.views.${v}`)}
                </label>
              ))}
            </fieldset>
            {current ? (
              view === "column" ? (
                <ColumnView key={current.file_id} fileId={current.file_id} />
              ) : view === "detail" ? (
                <DetailView key={current.file_id} fileId={current.file_id} dataset={dataset} />
              ) : (
                <CompactView key={current.file_id} fileId={current.file_id} path={current.path} dataset={dataset} />
              )
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
