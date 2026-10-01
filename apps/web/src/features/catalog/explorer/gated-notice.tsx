"use client";
import { Button } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { AccessRequestDialog } from "@/features/governance/components/access-request-dialog";
import { asApiError } from "@/shared/api/errors";
import type { Dataset } from "@/shared/api/types";

export function isGated(error: unknown): boolean {
  const e = asApiError(error);
  return e.status === 403 && e.details.reason === "DOWNLOAD_PERMISSION_REQUIRED";
}

export function GatedNotice({ dataset }: { dataset: Dataset }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  return (
    <div role="status" className="flex flex-col items-start gap-2 rounded-md border p-3 text-sm">
      <p>{t("data.explorer.gated")}</p>
      <Button size="sm" onClick={() => setOpen(true)}>{t("access.request.title")}</Button>
      <AccessRequestDialog dataset={dataset} open={open} onOpenChange={setOpen} />
    </div>
  );
}
