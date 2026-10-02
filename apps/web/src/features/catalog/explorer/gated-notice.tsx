"use client";
import { Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { AccessCta } from "../data-card/header";
import { asApiError } from "@/shared/api/errors";
import type { Dataset } from "@/shared/api/types";

export function isGated(error: unknown): boolean {
  const e = asApiError(error);
  return e.status === 403 && e.details.reason === "DOWNLOAD_PERMISSION_REQUIRED";
}

/** Raw values need download permission: a calm notice with the page's access action, not an error. */
export function GatedNotice({ dataset }: { dataset: Dataset }) {
  const t = useTranslations();
  return (
    <div role="status" className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border px-6 py-10 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-bg-hover text-fg-muted">
        <Lock aria-hidden="true" className="size-5" strokeWidth={1.75} />
      </span>
      <p className="text-body font-semibold text-fg">{t("data.explorer.gated")}</p>
      <p className="max-w-sm text-small text-fg-muted">{t("data.explorer.gatedHint")}</p>
      <AccessCta dataset={dataset} />
    </div>
  );
}
