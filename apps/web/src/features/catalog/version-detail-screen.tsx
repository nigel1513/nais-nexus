"use client";
import { Button, cn, ConfirmDialog, DataTable, focusRing } from "@nais/ui";
import { ArrowRight, Send } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { DownloadPanel } from "@/features/governance/components/download-panel";
import { ReadinessPanel } from "@/features/readiness/components/readiness-panel";
import { UploadPanel } from "@/features/upload/components/upload-panel";
import { useDeleteDraftFile } from "@/features/upload/api";
import { uploadMessageParams } from "@/features/upload/lib/paths";
import { asApiError } from "@/shared/api/errors";
import { useErrorText } from "@/shared/api/use-error-text";
import type { DatasetFile } from "@/shared/api/types";
import { useMeData } from "@/shared/hooks/use-me";
import { formatBytes, shortHash } from "@/shared/lib/format";
import { FileStatusBadge } from "@/shared/ui/badges";
import { CopyShaButton } from "@/shared/ui/copy-sha-button";
import { BandTag, SummaryBand, type BandFact } from "@/shared/ui/screen-v2";
import { PanelHead } from "@/shared/ui/work-hero";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { notify } from "@/shared/ui/toast";
import { useGetDataset, useGetDatasetVersion } from "./api";
import { useBreadcrumbs } from "@/shared/ui/breadcrumbs";
import type { ChangeSummary } from "./versions/diff-stat";
import { CitationBox } from "./versions/citation-box";
import { DraftBanner, useVersionLine } from "./versions/draft-banner";
import { PublishDialog } from "./versions/publish-dialog";
import { versionAccess } from "./versions/version-history-tab";

type IncompleteFile = { file_id?: string; path: string; status?: string };

/** DATASET_VERSION_INCOMPLETE carries details.files = the files that are not VERIFIED (M03 §6.5). */
function needsChangeNote(error: unknown): boolean {
  const e = asApiError(error);
  return e.code === "DATASET_VERSION_INCOMPLETE" && Array.isArray(e.details.reasons) && e.details.reasons.includes("CHANGE_NOTE_REQUIRED");
}

function incompleteFiles(error: unknown): IncompleteFile[] {
  const e = asApiError(error);
  if (e.code !== "DATASET_VERSION_INCOMPLETE") return [];
  const files = e.details.files;
  return Array.isArray(files) ? files.filter((f): f is IncompleteFile => !!f && typeof (f as IncompleteFile).path === "string") : [];
}

export function VersionDetailScreen({
  datasetId,
  versionId,
  focusDownload = false,
  readinessPollMs = 5000,
}: {
  datasetId: string;
  versionId: string;
  focusDownload?: boolean;
  readinessPollMs?: number;
}) {
  const t = useTranslations();
  const tv = useTranslations("data.versioning");
  const me = useMeData();
  const errorText = useErrorText();
  const ds = useGetDataset(datasetId);
  const v = useGetDatasetVersion(versionId, { pollMs: 1500 });
  const line = useVersionLine(datasetId);
  useBreadcrumbs([
    ...(ds.data ? [{ label: ds.data.title, href: `/commons/data/${datasetId}` }] : []),
    ...(v.data ? [{ label: t("version.title", { label: v.data.version_label }) }] : []),
  ]);
  const deleteFile = useDeleteDraftFile(versionId);
  const [publishing, setPublishing] = useState(false);
  const [deleting, setDeleting] = useState<DatasetFile | null>(null);
  const [publishError, setPublishError] = useState<unknown>(null);

  if (ds.isPending || v.isPending) return <DelayedSkeleton lines={6} />;
  if (ds.isError) return <ErrorView error={ds.error} onRetry={() => void ds.refetch()} />;
  if (v.isError) return <ErrorView error={v.error} onRetry={() => void v.refetch()} />;
  const dataset = ds.data;
  const version = v.data;
  const { steward } = versionAccess(me, dataset);
  const draft = version.status === "DRAFT";
  const published = version.status === "PUBLISHED";
  const stale = draft && version.base_is_latest === false;
  const canPublish = steward && draft && !stale && version.files.length > 0 && version.files.every((f) => f.status === "VERIFIED");
  const latest = line.latest;
  const isLatest = published && latest?.dataset_version_id === version.dataset_version_id;
  const notLatest = published && latest && !isLatest ? latest : null;
  const lineageId = draft ? version.base_version_id : version.previous_version_id;
  const lineageLabel = lineageId ? (line.labels.get(lineageId) ?? null) : null;
  const facts: BandFact[] = [
    { label: tv("detail.files"), value: version.file_count, unit: tv("detail.filesUnit") },
    { label: tv("detail.size"), value: formatBytes(version.total_bytes) },
    { label: draft ? tv("detail.base") : tv("detail.previous"), value: lineageLabel ?? tv("detail.none"), kind: lineageLabel ? "mono" : "text" },
    {
      label: tv("detail.change"),
      value: version.change_summary ? <BandDiff summary={version.change_summary} /> : "—",
      kind: "mono",
    },
  ];

  return (
    <>
      <SummaryBand
        label={tv("detail.summaryLabel")}
        context={[dataset.title, tv("detail.context")]}
        title={t("version.title", { label: version.version_label })}
        tags={
          <>
            <BandTag tone={draft ? "warn" : published ? "ok" : undefined}>{t(`enums.DatasetVersionStatus.${version.status}`)}</BandTag>
            {isLatest ? <BandTag tone="accent">{tv("latest")}</BandTag> : null}
            {version.manifest_sha256 ? (
              <BandTag>
                <span className="font-mono font-medium" title={version.manifest_sha256}>
                  {tv("detail.manifest")} {shortHash(version.manifest_sha256)}
                </span>
              </BandTag>
            ) : null}
          </>
        }
        actions={
          steward && draft ? (
            <button
              type="button"
              disabled={!canPublish}
              className={cn("sv-hb sv-hb-w disabled:cursor-not-allowed disabled:opacity-40", focusRing)}
              onClick={() => {
                setPublishError(null);
                setPublishing(true);
              }}
            >
              <Send aria-hidden="true" strokeWidth={1.75} />
              {t("version.publish")}
            </button>
          ) : null
        }
        facts={facts}
      />
      <div className="flex flex-col gap-6">
        {notLatest ? (
          <Link
            href={`/commons/data/${datasetId}/versions/${notLatest.dataset_version_id}`}
            className="group flex flex-wrap items-center gap-x-2 gap-y-1 self-start rounded-md border border-border bg-bg-panel px-3.5 py-2 text-small text-fg outline-none hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            <span className="font-semibold">{tv("notLatest")}</span>
            <span aria-hidden="true" className="text-fg-subtle">·</span>
            <span className="text-fg-muted group-hover:text-fg">
              {tv.rich("notLatestLink", { label: notLatest.version_label, v: (c) => <span className="font-mono text-[12.5px] font-medium text-fg">{c}</span> })}
            </span>
            <ArrowRight aria-hidden="true" strokeWidth={1.75} className="size-3.5 text-fg-muted" />
          </Link>
        ) : null}
        {steward && draft ? <DraftBanner version={version} datasetId={datasetId} /> : null}
        {publishError ? (
          <div role="alert" className="rounded-md border border-danger-line bg-danger-soft p-3 text-small text-fg">
            <p>{needsChangeNote(publishError) ? t("version.changeNoteRequired") : errorText(publishError)}</p>
            {incompleteFiles(publishError).length ? (
              <ul className="mt-2 list-disc pl-5">
                {incompleteFiles(publishError).map((f) => (
                  <li key={f.file_id ?? f.path}>
                    <code className="break-all">{f.path}</code> {f.status ? <FileStatusBadge status={f.status as DatasetFile["status"]} /> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {steward && draft && !stale && !canPublish ? <p className="-mt-2 text-small text-fg-muted">{t("version.publishHint")}</p> : null}
        <div className="flex flex-col gap-8">
          <section aria-labelledby="files-title" className="flex flex-col gap-3">
            <PanelHead id="files-title" crumb={tv("detail.filesCrumb")} title={t("version.files.title")} count={version.files.length} />
            <DataTable<DatasetFile>
              caption={t("version.files.title")}
              rows={version.files}
              rowKey={(f) => f.file_id}
              empty={<p className="text-sm text-muted-foreground">{t("version.files.empty")}</p>}
              columns={[
                {
                  key: "path",
                  header: t("version.files.path"),
                  cell: (f) => (
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <code className="break-all">{f.path}</code>
                      {f.inherited ? (
                        <span title={tv("inheritedHint")} className="inline-flex h-5 items-center rounded-xs border border-border px-1.5 text-caption font-medium text-fg-muted">
                          {tv("inherited")}
                        </span>
                      ) : null}
                    </span>
                  ),
                },
                { key: "size", header: t("version.files.size"), cell: (f) => <span className="num">{formatBytes(f.size_bytes)}</span> },
                {
                  key: "sha",
                  header: "SHA-256",
                  cell: (f) => (
                    <span className="flex items-center gap-1">
                      <code title={f.sha256}>{shortHash(f.sha256)}</code>
                      <CopyShaButton path={f.path} sha={f.sha256} />
                    </span>
                  ),
                },
                { key: "status", header: t("version.files.status"), cell: (f) => <FileStatusBadge status={f.status} /> },
                ...(steward && draft
                  ? [
                      {
                        key: "actions",
                        header: t("common.actions"),
                        cell: (f: DatasetFile) => (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={deleteFile.isPending}
                            aria-label={t("version.deleteFile", { path: f.path })}
                            onClick={() => setDeleting(f)}
                          >
                            {t("upload.remove")}
                          </Button>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          </section>
          {steward && draft ? <UploadPanel versionId={versionId} /> : null}
          {published ? <DownloadPanel dataset={dataset} versionId={versionId} focus={focusDownload} /> : null}
          {published ? <CitationBox versionId={versionId} label={version.version_label} /> : null}
          <ReadinessPanel versionId={versionId} published={published} steward={steward} pollMs={readinessPollMs} />
        </div>
        <ConfirmDialog
          open={!!deleting}
          onOpenChange={(o) => !o && setDeleting(null)}
          title={t("version.deleteTitle")}
          description={deleting ? t("version.deleteConfirm", { path: deleting.path }) : ""}
          confirmLabel={t("upload.remove")}
          cancelLabel={t("common.cancel")}
          closeLabel={t("common.close")}
          destructive
          pending={deleteFile.isPending}
          onConfirm={() =>
            deleting &&
            deleteFile.mutate(deleting.file_id, {
              onSuccess: () => {
                setDeleting(null);
                notify.success(t("version.deleted"));
              },
              onError: (e) => {
                setDeleting(null);
                notify.error(errorText(e, uploadMessageParams()));
              },
            })
          }
        />
        {steward && draft ? (
          <PublishDialog
            version={version}
            datasetId={datasetId}
            open={publishing}
            onOpenChange={setPublishing}
            onError={(e) => setPublishError(asApiError(e).code === "DATASET_VERSION_STALE_BASE" ? null : e)}
          />
        ) : null}
      </div>
    </>
  );
}

/** `+a −r ~c` on the dark band: hero tokens only (status colours fail contrast there); the glyph carries the meaning. */
function BandDiff({ summary }: { summary: ChangeSummary }) {
  const t = useTranslations("data.versioning");
  const sentence = t("summary", summary);
  const part = (glyph: string, n: number) => <span className={n ? "text-hero-fg" : "text-hero-fg-muted"}>{`${glyph}${n}`}</span>;
  return (
    <span title={sentence}>
      <span className="sr-only">{sentence}</span>
      <span aria-hidden="true" className="inline-flex gap-2.5">
        {part("+", summary.added)}
        {part("−", summary.removed)}
        {part("~", summary.changed)}
      </span>
    </span>
  );
}
