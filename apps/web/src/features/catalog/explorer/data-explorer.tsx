"use client";
import { EmptyState, PathText, SegmentedControl } from "@nais/ui";
import { FolderOpen } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import type { Dataset } from "@/shared/api/types";
import { formatBytes } from "@/shared/lib/format";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { useGetDatasetVersion } from "../api";
import { isTabular } from "../lib/tabular";
import { ColumnView } from "./column-view";
import { CompactView } from "./compact-view";
import { DetailView } from "./detail-view";
import { FileTree } from "./file-tree";
import { PanelHead } from "@/shared/ui/work-hero";

type View = "detail" | "compact" | "column";

/**
 * Data Explorer (reference A): one bordered panel — title, file count and the Detail / Compact / Column switch in its
 * header; a 220px file tree beside the view (stacked on phones).
 */
export function DataExplorer({ dataset, versionId, fileCount }: { dataset: Dataset; versionId: string; fileCount: number }) {
  const t = useTranslations();
  const version = useGetDatasetVersion(versionId);
  const [fileId, setFileId] = useState<string | undefined>();
  const [view, setView] = useState<View>("detail");
  const files = (version.data?.files ?? []).filter((f) => f.status === "VERIFIED");
  const current = files.find((f) => f.file_id === fileId) ?? files.find((f) => isTabular(f.path)) ?? files[0];

  let body: ReactNode;
  if (version.isPending) body = <div className="p-4"><DelayedSkeleton lines={3} /></div>;
  else if (version.isError) body = <div className="p-4"><ErrorView error={version.error} onRetry={() => void version.refetch()} /></div>;
  else if (files.length === 0) body = <EmptyState icon={FolderOpen} title={t("data.explorer.noFiles")} />;
  else
    body = (
      <div className="grid md:grid-cols-[256px_minmax(0,1fr)]">
        <div className="border-b border-border bg-bg-subtle p-2 md:border-b-0 md:border-r">
          <FileTree files={files} currentId={current?.file_id} onSelect={setFileId} />
        </div>
        <div className="flex min-w-0 flex-col gap-4 p-4">
          {current ? (
            <p className="-mx-4 -mt-4 flex min-w-0 items-center justify-between gap-3 border-b border-border px-4 py-2.5 text-small">
              <PathText value={current.path} className="min-w-0" />
              <span className="num shrink-0 font-mono text-mono text-fg-muted">{formatBytes(current.size_bytes)}</span>
            </p>
          ) : null}
          {current ? (
            view === "column" ? (
              <ColumnView key={current.file_id} fileId={current.file_id} />
            ) : view === "detail" ? (
              <DetailView key={current.file_id} fileId={current.file_id} path={current.path} dataset={dataset} />
            ) : (
              <CompactView key={current.file_id} fileId={current.file_id} path={current.path} dataset={dataset} />
            )
          ) : null}
        </div>
      </div>
    );

  return (
    <section aria-labelledby="explorer-title" className="overflow-hidden rounded-md border border-border bg-bg-panel">
      <div className="flex flex-wrap items-end justify-between gap-2 border-b border-border px-4 py-3">
        <PanelHead id="explorer-title" crumb={t("data.card.hero.explorerCrumb")} title={t("data.card.explorerTitle")} count={t("data.card.explorerFiles", { count: fileCount })} />
        <SegmentedControl
          aria-label={t("data.explorer.view")}
          value={view}
          onValueChange={(v) => setView(v as View)}
          items={(["detail", "compact", "column"] as const).map((v) => ({ value: v, label: t(`data.explorer.views.${v}`) }))}
        />
      </div>
      {body}
    </section>
  );
}
