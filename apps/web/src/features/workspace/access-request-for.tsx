"use client";
import { Dialog, DialogContent, DialogTitle } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useGetDataset } from "@/features/catalog/api";
import { AccessRequestDialog } from "@/features/governance/components/access-request-dialog";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";

/**
 * The governance access request for a dataset known only by id (an input whose access lapsed, or ACCESS_REQUIRED from
 * adding one): loads the dataset, then hands over to the existing AccessRequestDialog.
 */
export function AccessRequestFor({ datasetId, onClose }: { datasetId: string; onClose: () => void }) {
  const t = useTranslations();
  const ds = useGetDataset(datasetId);
  if (ds.data) return <AccessRequestDialog dataset={ds.data} open onOpenChange={(o) => (o ? undefined : onClose())} />;
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent closeLabel={t("common.close")} className="max-w-xl">
        <DialogTitle>{t("access.request.title")}</DialogTitle>
        {ds.isError ? <ErrorView error={ds.error} onRetry={() => void ds.refetch()} /> : <DelayedSkeleton lines={3} />}
      </DialogContent>
    </Dialog>
  );
}
