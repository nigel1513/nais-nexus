"use client";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@nais/ui";
import { useTranslations } from "next-intl";
import type { Dataset } from "@/shared/api/types";
import { notify } from "@/shared/ui/toast";
import { usePutDatasetContributors, useUpdateDataset } from "../api";
import { contributorsChanged, fromDataset, toDatasetUpdate } from "../schemas";
import { DatasetForm } from "./dataset-form";

/** Dataset edit in a 640px right sheet (spec §4 Sheet), so the data card stays in place behind it. */
export function DatasetEditSheet({ dataset, open, onOpenChange }: { dataset: Dataset; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations();
  const update = useUpdateDataset(dataset.dataset_id);
  const putContributors = usePutDatasetContributors(dataset.dataset_id);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent closeLabel={t("common.close")} className="max-w-[640px]">
        <SheetHeader>
          <SheetTitle>{t("data.edit.title")}</SheetTitle>
          <SheetDescription className="truncate">{t("data.edit.description", { title: dataset.title })}</SheetDescription>
        </SheetHeader>
        <DatasetForm
          mode="edit"
          layout="sheet"
          defaultValues={fromDataset(dataset)}
          ownerName={dataset.owner_organization_name ?? ""}
          ownerOrganizationId={dataset.owner_organization_id}
          onCancel={() => onOpenChange(false)}
          onSubmit={async (values) => {
            const before = fromDataset(dataset);
            const patch = toDatasetUpdate(values, before);
            if (Object.keys(patch).length) await update.mutateAsync(patch);
            if (contributorsChanged(before, values)) {
              await putContributors.mutateAsync({ contributors: values.contributors.map((c) => ({ user_id: c.user_id, role: c.role })) });
            }
            notify.success(t("data.detail.saved"));
            onOpenChange(false);
          }}
        />
      </SheetContent>
    </Sheet>
  );
}
