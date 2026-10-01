"use client";
import { useTranslations } from "next-intl";
import { AccessCta } from "../data-card/header";
import { asApiError } from "@/shared/api/errors";
import type { Dataset } from "@/shared/api/types";

export function isGated(error: unknown): boolean {
  const e = asApiError(error);
  return e.status === 403 && e.details.reason === "DOWNLOAD_PERMISSION_REQUIRED";
}

export function GatedNotice({ dataset }: { dataset: Dataset }) {
  const t = useTranslations();
  return (
    <div role="status" className="flex flex-col items-start gap-2 rounded-md border p-3 text-sm">
      <p>{t("data.explorer.gated")}</p>
      <AccessCta dataset={dataset} />
    </div>
  );
}
