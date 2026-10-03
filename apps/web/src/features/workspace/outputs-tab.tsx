"use client";
import { Button, DataTable, EmptyState, SegmentedControl } from "@nais/ui";
import { FileOutput, Upload } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { flattenPages } from "@/shared/api/pagination";
import type { Schemas } from "@/shared/api/types";
import { useUrlQuery } from "@/shared/hooks/use-url-query";
import { formatBytes } from "@/shared/lib/format";
import { AccessLevelBadge, OutputPublishBadge } from "@/shared/ui/badges";
import { DateTime } from "@/shared/ui/date-text";
import { DelayedSkeleton, ErrorView, LoadMore } from "@/shared/ui/state-views";
import { PanelHead } from "@/shared/ui/work-hero";
import { useOutputs, useProjectInputs, type Output } from "./api";
import { accessFloor, UploadOutputDialog } from "./upload-output-dialog";
import { projectHref, useWorkspace } from "./workspace-layout";

type KindFilter = "all" | Schemas["OutputKind"];

/** 산출물: derived datasets from runs and uploaded files, newest first; each opens its lineage and publication. */
export function OutputsTab() {
  const t = useTranslations();
  const { project, canWrite } = useWorkspace();
  const projectId = project.project_id;
  const [params, setParams] = useUrlQuery();
  const raw = params.get("kind");
  const kind: KindFilter = raw === "DERIVED_DATASET" || raw === "FILE" ? raw : "all";
  const outputs = useOutputs(projectId, kind === "all" ? undefined : kind);
  const inputs = useProjectInputs(projectId);
  const [uploading, setUploading] = useState(false);
  const rows = flattenPages(outputs.data);
  const floor = accessFloor((inputs.data?.items ?? []).map((i) => i.access_level));

  return (
    <section aria-labelledby="ws-outputs-title">
      <PanelHead
        id="ws-outputs-title"
        crumb={t("workspace.tabs.outputs")}
        title={t("workspace.outputs.title")}
        count={outputs.data && !outputs.hasNextPage ? rows.length : undefined}
        right={
          canWrite ? (
            <Button variant="primary" onClick={() => setUploading(true)} disabled={!inputs.isSuccess}>
              <Upload aria-hidden="true" strokeWidth={1.75} />
              {t("workspace.upload.title")}
            </Button>
          ) : null
        }
        className="mb-3"
      />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[72ch] text-small text-fg-muted">{t("workspace.outputs.hint")}</p>
        <SegmentedControl
          aria-label={t("workspace.outputs.kindFilter")}
          value={kind}
          onValueChange={(v) => setParams({ kind: v === "all" ? null : v })}
          items={[
            { value: "all", label: t("workspace.outputs.all") },
            { value: "DERIVED_DATASET", label: t("enums.OutputKind.DERIVED_DATASET") },
            { value: "FILE", label: t("enums.OutputKind.FILE") },
          ]}
        />
      </div>
      {outputs.isPending ? (
        <DelayedSkeleton />
      ) : outputs.isError ? (
        <ErrorView error={outputs.error} onRetry={() => void outputs.refetch()} />
      ) : (
        <>
          <DataTable<Output>
            caption={t("workspace.outputs.title")}
            rows={rows}
            rowKey={(o) => o.output_id}
            empty={<EmptyState icon={FileOutput} title={t("workspace.outputs.empty")} description={t("workspace.outputs.emptyHint")} />}
            columns={[
              {
                key: "title",
                header: t("workspace.outputs.name"),
                cell: (o) => (
                  <Link href={`${projectHref(projectId, "outputs")}/${o.output_id}`} className="font-medium text-fg underline-offset-4 hover:underline">
                    {o.title}
                  </Link>
                ),
              },
              { key: "kind", header: t("workspace.outputs.kind"), cell: (o) => t(`enums.OutputKind.${o.kind}`) },
              { key: "level", header: t("workspace.inputs.level"), cell: (o) => <AccessLevelBadge level={o.access_level} /> },
              { key: "publish", header: t("workspace.outputs.publish"), cell: (o) => <OutputPublishBadge status={o.publish_status} /> },
              { key: "size", header: t("workspace.outputs.size"), numeric: true, cell: (o) => formatBytes(o.files.reduce((n, f) => n + f.size_bytes, 0)) },
              { key: "created", header: t("workspace.outputs.created"), numeric: true, cell: (o) => <DateTime value={o.created_at} /> },
            ]}
          />
          <LoadMore hasNextPage={outputs.hasNextPage} isFetchingNextPage={outputs.isFetchingNextPage} fetchNextPage={outputs.fetchNextPage} />
        </>
      )}
      <UploadOutputDialog projectId={projectId} floor={floor} open={uploading} onOpenChange={setUploading} />
    </section>
  );
}
