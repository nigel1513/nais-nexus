"use client";
import { Button, DialogClose, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, FormField, Textarea } from "@nais/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { asApiError } from "@/shared/api/errors";
import { useErrorText } from "@/shared/api/use-error-text";
import type { DatasetVersion } from "@/shared/api/types";
import { notify } from "@/shared/ui/toast";
import { usePublishDatasetVersion } from "../api";
import { invalidateVersionViews, useUpdateVersionNote } from "./api";
import { DiffStat } from "./diff-stat";
import { useVersionLine } from "./draft-banner";

const NOTE_MIN = 3;
const NOTE_MAX = 2000;

/**
 * "버전 게시" (spec §3.3b): what changes against the base (+/−/~), the version name that becomes permanent, and the
 * required change note (3..2000 characters, prefilled from the draft). Saves the note, then publishes. A base that went
 * stale meanwhile closes the dialog so the draft banner can offer the rebase; other refusals go to `onError`.
 */
export function PublishDialog({
  version,
  datasetId,
  open,
  onOpenChange,
  onError,
}: {
  version: DatasetVersion;
  datasetId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onError?: (error: unknown) => void;
}) {
  const t = useTranslations("data.versioning.publish");
  const tc = useTranslations("common");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={tc("close")} className="sm:max-w-[32rem]">
        <DialogTitle>{t("title")}</DialogTitle>
        <DialogDescription className="break-keep">{t("warning")}</DialogDescription>
        {/* Mounted per open, so the note starts from the draft's current one every time. */}
        <PublishForm version={version} datasetId={datasetId} onClose={() => onOpenChange(false)} onError={onError} />
      </DialogContent>
    </Dialog>
  );
}

function PublishForm({ version, datasetId, onClose, onError }: { version: DatasetVersion; datasetId: string; onClose: () => void; onError?: (error: unknown) => void }) {
  const t = useTranslations("data.versioning.publish");
  const tv = useTranslations("data.versioning");
  const tc = useTranslations("common");
  const tr = useTranslations();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const { labels } = useVersionLine(datasetId);
  const saveNote = useUpdateVersionNote(version.dataset_version_id);
  const publish = usePublishDatasetVersion(version.dataset_version_id);
  const [note, setNote] = useState(version.change_note ?? "");
  const [error, setError] = useState<string | undefined>();
  const base = version.base_version_id ? (labels.get(version.base_version_id) ?? null) : null;
  const pending = saveNote.isPending || publish.isPending;
  const s = version.change_summary;

  const submit = async () => {
    const trimmed = note.trim();
    if (trimmed.length < NOTE_MIN) return setError(t("noteShort"));
    if (trimmed.length > NOTE_MAX) return setError(t("noteLong"));
    setError(undefined);
    try {
      if (trimmed !== (version.change_note ?? "").trim()) await saveNote.mutateAsync(trimmed);
    } catch (e) {
      return setError(errorText(e));
    }
    try {
      await publish.mutateAsync();
      onClose();
      notify.success(tr("version.published"));
    } catch (e) {
      onClose();
      if (asApiError(e).code === "DATASET_VERSION_STALE_BASE") invalidateVersionViews(qc, datasetId, version.dataset_version_id);
      // A stale base is told by the toast and the banner; other refusals by the screen's inline alert only.
      if (asApiError(e).code === "DATASET_VERSION_STALE_BASE") notify.error(errorText(e));
      onError?.(e);
    }
  };

  return (
    <form
      noValidate
      className="mt-4 flex flex-col gap-4 break-keep"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 border-y border-border py-3 text-small">
        <dt className="text-fg-muted">{t("label")}</dt>
        <dd className="flex min-w-0 flex-col gap-0.5">
          <span className="font-mono text-[13px] font-semibold text-fg">{version.version_label}</span>
          <span className="break-keep text-caption text-fg-muted">{t("labelFixed")}</span>
        </dd>
        <dt className="text-fg-muted">{tv("detail.change")}</dt>
        <dd className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          {s ? (
            <>
              <DiffStat summary={s} />
              {base ? (
                <span className="text-fg-muted">
                  {t.rich("against", {
                    label: base,
                    v: (c) => <span className="font-mono text-[12.5px] text-fg">{c}</span>,
                  })}
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-fg">{t("first", { count: version.file_count })}</span>
          )}
        </dd>
      </dl>
      <FormField id="publish-note" label={t("note")} required requiredLabel={tc("required")} hint={t("noteHint")} error={error}>
        {(a11y) => (
          <Textarea
            {...a11y}
            rows={4}
            maxLength={NOTE_MAX + 200}
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              if (error && e.target.value.trim().length >= NOTE_MIN) setError(undefined);
            }}
          />
        )}
      </FormField>
      <DialogFooter className="mt-2">
        <DialogClose render={<Button variant="secondary" />}>{tc("cancel")}</DialogClose>
        <Button variant="primary" type="submit" loading={pending} disabled={pending}>
          {t("submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
