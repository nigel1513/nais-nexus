"use client";
import { Badge, Button, ConfirmDialog, DataTable, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, EmptyState, FormField, Select, Textarea } from "@nais/ui";
import { Database, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { useListDatasetVersions } from "@/features/catalog/api";
import { ProjectDataTab } from "@/features/projects/components/project-data-tab";
import { useErrorText } from "@/shared/api/use-error-text";
import { AccessLevelBadge } from "@/shared/ui/badges";
import { DateTime } from "@/shared/ui/date-text";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { notify } from "@/shared/ui/toast";
import { PanelHead } from "@/shared/ui/work-hero";
import { AccessRequestFor } from "./access-request-for";
import { AddInputDialog } from "./add-input-dialog";
import { useProjectInputs, useRemoveProjectInput, useUpdateProjectInput, type ProjectInput } from "./api";
import { useWorkspace } from "./workspace-layout";

/**
 * 데이터: the datasets this project works on, each pinned to one published version. An input whose access was revoked
 * or expired for me is marked; runs and downloads that read it are blocked until access is granted again. Below, the
 * access grants and requests made for the project.
 */
export function InputsTab() {
  const t = useTranslations();
  const errorText = useErrorText();
  const { project, canWrite } = useWorkspace();
  const projectId = project.project_id;
  const inputs = useProjectInputs(projectId);
  const remove = useRemoveProjectInput(projectId);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ProjectInput | null>(null);
  const [removing, setRemoving] = useState<ProjectInput | null>(null);
  const [requestFor, setRequestFor] = useState<string | null>(null);
  const rows = inputs.data?.items ?? [];

  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby="ws-inputs-title">
        <PanelHead
          id="ws-inputs-title"
          crumb={t("workspace.tabs.data")}
          title={t("workspace.inputs.title")}
          count={inputs.data ? rows.length : undefined}
          right={
            canWrite ? (
              <Button variant="primary" onClick={() => setAdding(true)}>
                <Plus aria-hidden="true" strokeWidth={1.75} />
                {t("workspace.addInput.title")}
              </Button>
            ) : null
          }
          className="mb-3"
        />
        {inputs.isPending ? (
          <DelayedSkeleton />
        ) : inputs.isError ? (
          <ErrorView error={inputs.error} onRetry={() => void inputs.refetch()} />
        ) : (
          <DataTable<ProjectInput>
            caption={t("workspace.inputs.title")}
            rows={rows}
            rowKey={(i) => i.input_id}
            empty={<EmptyState icon={Database} title={t("workspace.inputs.empty")} description={t("workspace.inputs.emptyHint")} />}
            columns={[
              {
                key: "dataset",
                header: t("workspace.inputs.dataset"),
                cell: (i) => (
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <Link href={`/commons/data/${i.dataset_id}`} className="font-medium text-fg underline-offset-4 hover:underline">
                      {i.dataset_title}
                    </Link>
                    {i.note ? <span className="text-small text-fg-muted">{i.note}</span> : null}
                  </span>
                ),
              },
              {
                key: "version",
                header: t("workspace.inputs.version"),
                cell: (i) => (
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="num font-mono text-mono">{i.version_label}</span>
                    {i.newer_version_label ? <Badge tone="info">{t("workspace.inputs.newer", { version: i.newer_version_label })}</Badge> : null}
                  </span>
                ),
              },
              { key: "level", header: t("workspace.inputs.level"), cell: (i) => <AccessLevelBadge level={i.access_level} /> },
              {
                key: "access",
                header: t("workspace.inputs.access"),
                cell: (i) =>
                  i.access_lapsed ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge tone="danger">{t("workspace.inputs.lapsed")}</Badge>
                      <Button size="sm" variant="secondary" onClick={() => setRequestFor(i.dataset_id)}>
                        {t("workspace.inputs.requestAgain")}
                      </Button>
                    </span>
                  ) : (
                    <span className="text-small text-fg-muted">{t("workspace.inputs.usable")}</span>
                  ),
              },
              {
                key: "added",
                header: t("workspace.inputs.added"),
                cell: (i) => (
                  <span className="text-small text-fg-muted">
                    {i.added_by_display_name} · <DateTime value={i.added_at} dateOnly />
                  </span>
                ),
              },
              ...(canWrite
                ? [
                    {
                      key: "actions",
                      header: t("workspace.inputs.actions"),
                      cell: (i: ProjectInput) => (
                        <span className="flex gap-1">
                          <Button size="sm" variant="ghost" aria-label={t("workspace.inputs.editLabel", { title: i.dataset_title })} onClick={() => setEditing(i)}>
                            <Pencil aria-hidden="true" strokeWidth={1.75} />
                            {t("common.edit")}
                          </Button>
                          <Button size="sm" variant="ghost" aria-label={t("workspace.inputs.removeLabel", { title: i.dataset_title })} onClick={() => setRemoving(i)}>
                            <Trash2 aria-hidden="true" strokeWidth={1.75} />
                            {t("workspace.inputs.remove")}
                          </Button>
                        </span>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
      </section>
      <ProjectDataTab projectId={projectId} />
      <AddInputDialog
        projectId={projectId}
        usedDatasetIds={new Set(rows.map((i) => i.dataset_id))}
        open={adding}
        onOpenChange={setAdding}
        onRequestAccess={(datasetId) => {
          setAdding(false);
          setRequestFor(datasetId);
        }}
      />
      {editing ? <EditInputDialog projectId={projectId} input={editing} onClose={() => setEditing(null)} /> : null}
      {requestFor ? <AccessRequestFor datasetId={requestFor} onClose={() => setRequestFor(null)} /> : null}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => (o ? undefined : setRemoving(null))}
        title={t("workspace.inputs.removeTitle")}
        description={t("workspace.inputs.removeWarning", { title: removing?.dataset_title ?? "" })}
        confirmLabel={t("workspace.inputs.remove")}
        cancelLabel={t("common.cancel")}
        closeLabel={t("common.close")}
        destructive
        pending={remove.isPending}
        onConfirm={() =>
          removing &&
          remove.mutate(removing, {
            onSuccess: () => {
              setRemoving(null);
              notify.success(t("workspace.inputs.removed"));
            },
            onError: (e) => {
              setRemoving(null);
              notify.error(errorText(e));
            },
          })
        }
      />
    </div>
  );
}

/** Pin another published version (an explicit, audited change) and edit the note. */
function EditInputDialog({ projectId, input, onClose }: { projectId: string; input: ProjectInput; onClose: () => void }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const id = useId();
  const versions = useListDatasetVersions(input.dataset_id);
  const update = useUpdateProjectInput(projectId);
  const [versionId, setVersionId] = useState(input.dataset_version_id);
  const [note, setNote] = useState(input.note ?? "");
  const published = (versions.data?.items ?? []).filter((v) => v.status === "PUBLISHED");
  const changed = versionId !== input.dataset_version_id || note.trim() !== (input.note ?? "");
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent closeLabel={t("common.close")} className="max-w-lg">
        <DialogTitle>{t("workspace.inputs.editTitle")}</DialogTitle>
        <DialogDescription>{input.dataset_title}</DialogDescription>
        <form
          className="mt-4 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!changed) return;
            update.mutate(
              {
                inputId: input.input_id,
                ...(versionId !== input.dataset_version_id ? { dataset_version_id: versionId } : {}),
                ...(note.trim() !== (input.note ?? "") ? { note: note.trim() || null } : {}),
              },
              {
                onSuccess: () => {
                  notify.success(t("workspace.inputs.saved"));
                  onClose();
                },
                onError: (err) => notify.error(errorText(err)),
              },
            );
          }}
        >
          {versions.isError ? (
            <ErrorView error={versions.error} onRetry={() => void versions.refetch()} />
          ) : (
            <FormField id={`${id}-version`} label={t("workspace.inputs.version")} hint={t("workspace.inputs.versionHint")}>
              {(a11y) => (
                <Select {...a11y} value={versionId} disabled={versions.isPending} onChange={(e) => setVersionId(e.target.value)}>
                  {published.some((v) => v.dataset_version_id === input.dataset_version_id) ? null : <option value={input.dataset_version_id}>{input.version_label}</option>}
                  {published.map((v) => (
                    <option key={v.dataset_version_id} value={v.dataset_version_id}>
                      {v.version_label}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
          )}
          <FormField id={`${id}-note`} label={t("data.card.openInProject.note")}>
            {(a11y) => <Textarea {...a11y} rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />}
          </FormField>
          <DialogFooter className="mt-2">
            <Button variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={!changed || update.isPending}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
