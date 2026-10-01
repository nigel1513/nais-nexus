"use client";
import { Button } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { useGetReadiness } from "@/features/readiness/api";
import { CheckStatusBadge } from "@/shared/ui/badges";
import { aiReadyScore } from "../lib/ai-ready-score";

export function AiReadyBadge({ versionId }: { versionId: string }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const { data, isPending } = useGetReadiness(versionId);
  const { score, checks } = aiReadyScore(data?.items ?? []);
  const label = isPending ? t("data.card.aiReadyLoading") : score === null ? t("data.card.aiReadyUnverified") : t("data.card.aiReady", { score: score.toFixed(1) });
  return (
    <div className="flex flex-col gap-2">
      <Button variant="outline" size="sm" aria-expanded={open} aria-controls={panelId} disabled={isPending || score === null} onClick={() => setOpen((o) => !o)}>
        {label}
      </Button>
      {open && score !== null ? (
        <ul id={panelId} className="flex flex-col gap-1 text-sm">
          {checks.map((c) => (
            <li key={c.check_id} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{t.has(`readiness.check.${c.check_id}`) ? t(`readiness.check.${c.check_id}`) : c.check_id}</span>
              <CheckStatusBadge status={c.status} />
              <span className="text-muted-foreground">{c.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
