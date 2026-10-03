"use client";
import { Button, buttonClass, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, FormField, Radio, RadioGroup, Textarea } from "@nais/ui";
import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { useAddProjectInput, useDatasetProjects } from "@/features/hub/api";
import { useListProjects } from "@/features/projects/api";
import { asApiError } from "@/shared/api/errors";
import { flattenPages } from "@/shared/api/pagination";
import type { Dataset, DatasetVersion } from "@/shared/api/types";
import { useErrorText } from "@/shared/api/use-error-text";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { notify } from "@/shared/ui/toast";

/**
 * 프로젝트에서 열기: pin this dataset (the version on screen when it is published, else the latest published one) as an
 * input of one of my active projects where I can write. Projects already using it are shown but not selectable.
 * Without an access grant the server answers ACCESS_REQUIRED and the dialog hands over to the access request.
 */
export function OpenInProjectDialog({
  dataset,
  version,
  open,
  onOpenChange,
  onRequestAccess,
}: {
  dataset: Dataset;
  version: DatasetVersion | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestAccess: () => void;
}) {
  const t = useTranslations();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t("common.close")} className="max-w-lg">
        <DialogTitle>{t("data.card.openInProject.title")}</DialogTitle>
        <DialogDescription>
          {version?.status === "PUBLISHED" ? t("data.card.openInProject.description", { version: version.version_label }) : t("data.card.openInProject.descriptionLatest")}
        </DialogDescription>
        {open ? <OpenForm dataset={dataset} version={version} onDone={() => onOpenChange(false)} onRequestAccess={onRequestAccess} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function OpenForm({ dataset, version, onDone, onRequestAccess }: { dataset: Dataset; version: DatasetVersion | undefined; onDone: () => void; onRequestAccess: () => void }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const id = useId();
  // One page of up to 100 active projects (the API maximum), as the access request dialog does: a researcher is in far
  // fewer, so no paging here.
  const projects = useListProjects({ scope: "mine", status: "ACTIVE", limit: 100 });
  const using = useDatasetProjects(dataset.dataset_id);
  const add = useAddProjectInput();
  const [projectId, setProjectId] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<unknown>(null);

  if (projects.isPending || using.isPending) return <DelayedSkeleton lines={3} />;
  if (projects.isError) return <ErrorView error={projects.error} onRetry={() => void projects.refetch()} />;
  const writable = flattenPages(projects.data).filter((p) => p.my_role && p.my_role !== "VIEWER");
  const used = new Set((using.data?.items ?? []).map((p) => p.project_id));

  if (!writable.length) {
    return (
      <div className="mt-4 flex flex-col items-start gap-3">
        <p className="text-small text-fg-muted">{t("data.card.openInProject.noProject")}</p>
        <Link href="/commons/projects/new" className={buttonClass("primary")}>
          {t("projects.new.title")}
        </Link>
      </div>
    );
  }

  const apiError = error ? asApiError(error) : null;
  const submit = () => {
    if (!projectId || using.isError) return;
    setError(null);
    const project = writable.find((p) => p.project_id === projectId);
    add.mutate(
      {
        projectId,
        dataset_id: dataset.dataset_id,
        ...(version?.status === "PUBLISHED" ? { dataset_version_id: version.dataset_version_id } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      },
      {
        onSuccess: (input) => {
          notify.success(t("data.card.openInProject.done", { project: project?.name ?? "" }), { description: t("data.card.openInProject.doneVersion", { version: input.version_label }) });
          onDone();
        },
        onError: setError,
      },
    );
  };

  return (
    <form
      className="mt-4 flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <fieldset className="flex flex-col gap-2">
        <legend id={`${id}-legend`} className="mb-2 text-small font-medium text-fg">
          {t("data.card.openInProject.project")}
        </legend>
        <RadioGroup aria-labelledby={`${id}-legend`} value={projectId} onValueChange={setProjectId} className="gap-0 divide-y divide-border rounded-md border border-border">
          {writable.map((p) => (
            <Radio
              key={p.project_id}
              value={p.project_id}
              disabled={used.has(p.project_id)}
              className="flex w-full px-3 py-2.5"
              label={
                <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3">
                  <span className="min-w-0 break-keep">{p.name}</span>
                  <span className="text-small text-fg-muted">{used.has(p.project_id) ? t("data.card.openInProject.alreadyUsed") : (p.lead_organization_name ?? "")}</span>
                </span>
              }
            />
          ))}
        </RadioGroup>
      </fieldset>
      <FormField id={`${id}-note`} label={t("data.card.openInProject.note")} hint={t("data.card.openInProject.noteHint")}>
        {(a11y) => <Textarea {...a11y} rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />}
      </FormField>
      {using.isError ? (
        <p role="alert" className="text-small text-danger">
          {t("data.card.openInProject.usageFailed")}
        </p>
      ) : null}
      {apiError ? (
        <div role="alert" className="flex gap-2 rounded-sm bg-warning-soft p-3 text-small">
          <TriangleAlert aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="flex flex-col items-start gap-2">
            <p className="text-fg">{errorText(apiError)}</p>
            {apiError.code === "ACCESS_REQUIRED" ? (
              <Button size="sm" variant="primary" onClick={onRequestAccess}>
                {t("access.request.title")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      <DialogFooter className="mt-2">
        <Button variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={!projectId || add.isPending || using.isError}>
          {t("data.card.openInProject.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
