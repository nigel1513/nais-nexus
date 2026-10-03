"use client";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, FormField, Input, Radio, RadioGroup, Textarea } from "@nais/ui";
import { TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { useSearchDatasets } from "@/features/catalog/api";
import { useAddProjectInput } from "@/features/hub/api";
import { asApiError } from "@/shared/api/errors";
import { flattenPages } from "@/shared/api/pagination";
import { useErrorText } from "@/shared/api/use-error-text";
import { AccessLevelBadge } from "@/shared/ui/badges";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { notify } from "@/shared/ui/toast";

const SEARCH_DELAY_MS = 300;
const RESULTS = 20;

/**
 * 데이터 추가: find a dataset in the catalog and pin its latest published version as a project input. Datasets already
 * used here, and ones without a published version, are shown but not selectable. Without an access grant the server
 * answers ACCESS_REQUIRED and the dialog hands over to the access request.
 */
export function AddInputDialog({
  projectId,
  usedDatasetIds,
  open,
  onOpenChange,
  onRequestAccess,
}: {
  projectId: string;
  usedDatasetIds: Set<string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestAccess: (datasetId: string) => void;
}) {
  const t = useTranslations();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t("common.close")} className="max-w-xl">
        <DialogTitle>{t("workspace.addInput.title")}</DialogTitle>
        <DialogDescription>{t("workspace.addInput.description")}</DialogDescription>
        {open ? <AddForm projectId={projectId} used={usedDatasetIds} onDone={() => onOpenChange(false)} onRequestAccess={onRequestAccess} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function AddForm({ projectId, used, onDone, onRequestAccess }: { projectId: string; used: Set<string>; onDone: () => void; onRequestAccess: (datasetId: string) => void }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const id = useId();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);
  const search = useSearchDatasets({ ...(q ? { q } : {}), sort: q ? "relevance" : "updated_desc", limit: RESULTS });
  const add = useAddProjectInput();
  const [datasetId, setDatasetId] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<unknown>(null);
  const hits = flattenPages(search.data);
  const apiError = error ? asApiError(error) : null;

  const submit = () => {
    if (!datasetId) return;
    setError(null);
    add.mutate(
      { projectId, dataset_id: datasetId, ...(note.trim() ? { note: note.trim() } : {}) },
      {
        onSuccess: (input) => {
          notify.success(t("workspace.addInput.done", { title: input.dataset_title, version: input.version_label }));
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
      <FormField id={`${id}-q`} label={t("workspace.addInput.search")}>
        {(a11y) => <Input {...a11y} type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("workspace.addInput.searchPlaceholder")} />}
      </FormField>
      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend id={`${id}-legend`} className="mb-2 text-small font-medium text-fg">
          {t("workspace.addInput.dataset")}
        </legend>
        {search.isPending ? (
          <DelayedSkeleton lines={3} />
        ) : search.isError ? (
          <ErrorView error={search.error} onRetry={() => void search.refetch()} />
        ) : hits.length ? (
          <RadioGroup
            aria-labelledby={`${id}-legend`}
            value={datasetId}
            onValueChange={setDatasetId}
            className="max-h-72 gap-0 divide-y divide-border overflow-y-auto rounded-md border border-border"
          >
            {hits.map((h) => {
              const reason = used.has(h.dataset_id) ? t("workspace.addInput.alreadyUsed") : !h.latest_version_label ? t("workspace.addInput.noVersion") : null;
              return (
                <Radio
                  key={h.dataset_id}
                  value={h.dataset_id}
                  disabled={!!reason}
                  className="flex w-full px-3 py-2.5"
                  label={
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="min-w-0 break-keep">{h.title}</span>
                      <span className="flex flex-wrap items-center gap-x-2 text-small text-fg-muted">
                        {reason ?? [h.owner_organization_name, h.latest_version_label].filter(Boolean).join(" · ")}
                        <AccessLevelBadge level={h.access_level} />
                      </span>
                    </span>
                  }
                />
              );
            })}
          </RadioGroup>
        ) : (
          <p className="text-small text-fg-muted">{t("workspace.addInput.noResults")}</p>
        )}
      </fieldset>
      <FormField id={`${id}-note`} label={t("data.card.openInProject.note")} hint={t("data.card.openInProject.noteHint")}>
        {(a11y) => <Textarea {...a11y} rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />}
      </FormField>
      {apiError ? (
        <div role="alert" className="flex gap-2 rounded-sm bg-warning-soft p-3 text-small">
          <TriangleAlert aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="flex flex-col items-start gap-2">
            <p className="text-fg">{errorText(apiError)}</p>
            {apiError.code === "ACCESS_REQUIRED" ? (
              <Button size="sm" variant="primary" onClick={() => onRequestAccess(String(apiError.details.dataset_id ?? datasetId))}>
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
        <Button type="submit" variant="primary" disabled={!datasetId || add.isPending}>
          {t("workspace.addInput.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
