"use client";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, FormField, Input, Textarea } from "@nais/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useErrorText } from "@/shared/api/use-error-text";
import { useCreateDatasetVersion } from "../api";

export function NewVersionDialog({ datasetId, open, onOpenChange }: { datasetId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useTranslations();
  const router = useRouter();
  const errorText = useErrorText();
  const create = useCreateDatasetVersion(datasetId);
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | undefined>();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t("common.close")}>
        <DialogTitle>{t("data.version.newTitle")}</DialogTitle>
        <DialogDescription>{t("data.version.newDescription")}</DialogDescription>
        <form
          className="mt-4 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!/^[A-Za-z0-9._-]{1,32}$/.test(label)) {
              setError(t("validation.versionLabel"));
              return;
            }
            create.mutate(
              { version_label: label, ...(note.trim() ? { change_note: note.trim() } : {}) },
              {
                onSuccess: (v) => router.push(`/commons/data/${datasetId}/versions/${v.dataset_version_id}`),
                onError: (err) => setError(errorText(err)),
              },
            );
          }}
        >
          <FormField id="version-label" label={t("data.version.label")} required requiredLabel={t("common.required")} hint={t("data.version.labelHint")} error={error}>
            {(a11y) => <Input {...a11y} value={label} onChange={(e) => setLabel(e.target.value)} />}
          </FormField>
          <FormField id="version-note" label={t("data.version.changeNote")}>
            {(a11y) => <Textarea {...a11y} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />}
          </FormField>
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              {t("data.version.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
