"use client";
import { ConfirmDialog, Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useCallback, useRef, useState } from "react";
import type { Dataset } from "@/shared/api/types";
import { notify } from "@/shared/ui/toast";
import { usePutDatasetContributors, useUpdateDataset } from "../api";
import { contributorsChanged, fromDataset, toDatasetUpdate } from "../schemas";
import { DatasetForm } from "./dataset-form";

/**
 * Dataset edit in a 640px right sheet (spec §4 Sheet), so the data card stays in place behind it. Closing with
 * unsaved changes (Esc, outside click, ×, 취소) asks first; closing after a successful save does not.
 */
export function DatasetEditSheet({ dataset, open, onOpenChange }: { dataset: Dataset; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations();
  const update = useUpdateDataset(dataset.dataset_id);
  const putContributors = usePutDatasetContributors(dataset.dataset_id);
  const dirty = useRef(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const onDirtyChange = useCallback((d: boolean) => {
    dirty.current = d;
  }, []);
  const close = () => {
    dirty.current = false;
    onOpenChange(false);
  };
  const requestClose = () => {
    if (dirty.current) setConfirmDiscard(true);
    else close();
  };

  return (
    <>
      <Sheet open={open} onOpenChange={(o) => (o ? onOpenChange(true) : requestClose())}>
        <SheetContent closeLabel={t("common.close")} className="max-w-[640px]">
          <SheetHeader className="sticky top-0 z-[var(--z-sticky)] bg-bg-panel">
            <SheetTitle>{t("data.edit.title")}</SheetTitle>
            <SheetDescription className="truncate">{t("data.edit.description", { title: dataset.title })}</SheetDescription>
          </SheetHeader>
          <DatasetForm
            mode="edit"
            layout="sheet"
            defaultValues={fromDataset(dataset)}
            ownerName={dataset.owner_organization_name ?? ""}
            ownerOrganizationId={dataset.owner_organization_id}
            onDirtyChange={onDirtyChange}
            onCancel={requestClose}
            onSubmit={async (values) => {
              const before = fromDataset(dataset);
              const patch = toDatasetUpdate(values, before);
              if (Object.keys(patch).length) await update.mutateAsync(patch);
              if (contributorsChanged(before, values)) {
                await putContributors.mutateAsync({ contributors: values.contributors.map((c) => ({ user_id: c.user_id, role: c.role })) });
              }
              notify.success(t("data.detail.saved"));
              close();
            }}
          />
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title={t("data.edit.discardTitle")}
        description={t("data.edit.discardDescription")}
        confirmLabel={t("data.edit.discard")}
        cancelLabel={t("data.edit.keepEditing")}
        closeLabel={t("common.close")}
        destructive
        onConfirm={() => {
          setConfirmDiscard(false);
          close();
        }}
      />
    </>
  );
}
