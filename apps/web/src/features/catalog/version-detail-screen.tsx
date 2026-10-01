"use client";
import { Button, ConfirmDialog, DataTable } from "@nais/ui";
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
import { FileStatusBadge, VersionStatusBadge } from "@/shared/ui/badges";
import { PageHeader } from "@/shared/ui/page-header";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { useToast } from "@/shared/ui/toast";
import { useGetDataset, useGetDatasetVersion, usePublishDatasetVersion } from "./api";

type IncompleteFile = { file_id?: string; path: string; status?: string };

/** DATASET_VERSION_INCOMPLETE carries details.files = the files that are not VERIFIED (M03 §6.5). */
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
  const me = useMeData();
  const toast = useToast();
  const errorText = useErrorText();
  const ds = useGetDataset(datasetId);
  const v = useGetDatasetVersion(versionId, { pollMs: 1500 });
  const publish = usePublishDatasetVersion(versionId);
  const deleteFile = useDeleteDraftFile(versionId);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState<DatasetFile | null>(null);
  const [publishError, setPublishError] = useState<unknown>(null);

  const copySha = (sha: string) => {
    const fail = () => toast(t("download.copyFailed"), "error");
    if (!navigator.clipboard?.writeText) return fail();
    navigator.clipboard.writeText(sha).then(() => toast(t("download.copiedSha")), fail);
  };

  if (ds.isPending || v.isPending) return <DelayedSkeleton lines={6} />;
  if (ds.isError) return <ErrorView error={ds.error} onRetry={() => void ds.refetch()} />;
  if (v.isError) return <ErrorView error={v.error} onRetry={() => void v.refetch()} />;
  const dataset = ds.data;
  const version = v.data;
  const steward = me.organization.organization_id === dataset.owner_organization_id && me.org_roles.includes("DATA_STEWARD");
  const draft = version.status === "DRAFT";
  const published = version.status === "PUBLISHED";
  const canPublish = steward && draft && version.files.length > 0 && version.files.every((f) => f.status === "VERIFIED");

  return (
    <>
      <nav aria-label={t("common.breadcrumb")} className="mb-2 text-sm">
        <ol className="flex flex-wrap gap-2">
          <li>
            <Link href="/commons/data" className="underline-offset-4 hover:underline">
              {t("nav.data")}
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <Link href={`/commons/data/${datasetId}`} className="underline-offset-4 hover:underline">
              {dataset.title}
            </Link>
          </li>
        </ol>
      </nav>
      <PageHeader
        title={t("version.title", { label: version.version_label })}
        actions={
          steward && draft ? (
            <Button disabled={!canPublish} onClick={() => setConfirming(true)}>
              {t("version.publish")}
            </Button>
          ) : null
        }
      >
        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
          <VersionStatusBadge status={version.status} />
          <span>{t("version.fileCount", { count: version.file_count })}</span>
          <span>{formatBytes(version.total_bytes)}</span>
          {version.manifest_sha256 ? (
            <span>
              manifest <code title={version.manifest_sha256}>{shortHash(version.manifest_sha256)}</code>
            </span>
          ) : null}
        </div>
      </PageHeader>
      {publishError ? (
        <div role="alert" className="mb-4 rounded-md border border-danger p-3 text-sm">
          <p>{errorText(publishError)}</p>
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
      {steward && draft && !canPublish ? <p className="mb-4 text-sm text-muted-foreground">{t("version.publishHint")}</p> : null}
      <div className="flex flex-col gap-8">
        <section aria-labelledby="files-title">
          <h2 id="files-title" className="mb-2 text-lg font-semibold">
            {t("version.files.title")}
          </h2>
          <DataTable<DatasetFile>
            caption={t("version.files.title")}
            rows={version.files}
            rowKey={(f) => f.file_id}
            empty={<p className="text-sm text-muted-foreground">{t("version.files.empty")}</p>}
            columns={[
              { key: "path", header: t("version.files.path"), cell: (f) => <code className="break-all">{f.path}</code> },
              { key: "size", header: t("version.files.size"), cell: (f) => formatBytes(f.size_bytes) },
              {
                key: "sha",
                header: "SHA-256",
                cell: (f) => (
                  <span className="flex items-center gap-1">
                    <code title={f.sha256}>{shortHash(f.sha256)}</code>
                    <Button size="sm" variant="ghost" aria-label={t("download.copyShaFor", { path: f.path })} onClick={() => copySha(f.sha256)}>
                      {t("download.copySha")}
                    </Button>
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
              toast(t("version.deleted"));
            },
            onError: (e) => {
              setDeleting(null);
              toast(errorText(e, uploadMessageParams()), "error");
            },
          })
        }
      />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("version.publishTitle")}
        description={t("version.publishWarning")}
        confirmLabel={t("version.publish")}
        cancelLabel={t("common.cancel")}
        closeLabel={t("common.close")}
        pending={publish.isPending}
        onConfirm={() =>
          publish.mutate(undefined, {
            onSuccess: () => {
              setConfirming(false);
              setPublishError(null);
              toast(t("version.published"));
            },
            onError: (e) => {
              setConfirming(false);
              setPublishError(e);
              toast(errorText(e), "error");
            },
          })
        }
      />
    </>
  );
}
