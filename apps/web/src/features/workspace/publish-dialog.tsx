"use client";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, FormField, Input, Textarea } from "@nais/ui";
import { TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { asApiError, fieldErrors } from "@/shared/api/errors";
import { useErrorText } from "@/shared/api/use-error-text";
import { notify } from "@/shared/ui/toast";
import { useRequestPublish, type Output } from "./api";

/**
 * 허브 공개 요청: ask for the output to become a hub dataset owned by the project's lead organization. A data steward
 * of every organization whose data it derives from (and of the lead organization) approves it; the request shows
 * those approval slots once sent.
 */
export function PublishDialog({ projectId, output, open, onOpenChange }: { projectId: string; output: Output; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t("common.close")} className="max-w-xl">
        <DialogTitle>{t("workspace.publish.title")}</DialogTitle>
        <DialogDescription>{t("workspace.publish.description")}</DialogDescription>
        {open ? <PublishForm projectId={projectId} output={output} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function PublishForm({ projectId, output, onDone }: { projectId: string; output: Output; onDone: () => void }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const id = useId();
  const request = useRequestPublish(projectId, output.output_id);
  const [title, setTitle] = useState(output.title);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<unknown>(null);
  const apiError = error ? asApiError(error) : null;
  const titleError = apiError?.code === "VALIDATION_FAILED" ? fieldErrors(apiError).title : undefined;
  const short = title.trim().length < 3;
  return (
    <form
      className="mt-4 flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (short) return;
        setError(null);
        request.mutate(
          { title: title.trim(), ...(description.trim() ? { description: description.trim() } : {}) },
          {
            onSuccess: (r) => {
              notify.success(t("workspace.publish.sent", { count: r.approvals.length }));
              onDone();
            },
            onError: setError,
          },
        );
      }}
    >
      <FormField id={`${id}-title`} label={t("workspace.publish.datasetTitle")} hint={t("workspace.publish.datasetTitleHint")} error={titleError ? t("workspace.publish.titleShort") : undefined}>
        {(a11y) => <Input {...a11y} value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />}
      </FormField>
      <FormField id={`${id}-desc`} label={t("workspace.publish.datasetDescription")} hint={t("workspace.publish.datasetDescriptionHint")}>
        {(a11y) => <Textarea {...a11y} rows={4} maxLength={20_000} value={description} onChange={(e) => setDescription(e.target.value)} />}
      </FormField>
      <p className="text-small text-fg-muted">{t("workspace.publish.levelNote", { level: t(`enums.AccessLevel.${output.access_level}`) })}</p>
      {apiError && !titleError ? (
        <p role="alert" className="flex items-start gap-2 rounded-sm bg-warning-soft p-3 text-small text-fg">
          <TriangleAlert aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0 text-warning" />
          {errorText(apiError)}
        </p>
      ) : null}
      <DialogFooter className="mt-2">
        <Button variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={short || request.isPending}>
          {t("workspace.publish.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
