"use client";
import { useTranslations } from "next-intl";
import type { DatasetVersion } from "@/shared/api/types";
import { formatDate } from "@/shared/lib/format";

export function ActivitySummary({ versions }: { versions: Pick<DatasetVersion, "status" | "published_at">[] }) {
  const t = useTranslations();
  const published = versions.filter((v) => v.status === "PUBLISHED");
  const last = published
    .map((v) => v.published_at)
    .filter((p): p is string => !!p)
    .sort()
    .at(-1);
  return (
    <p className="text-sm text-muted-foreground">
      {last ? t("data.card.activity", { count: published.length, date: formatDate(last) }) : t("data.card.activityNone", { count: published.length })}
    </p>
  );
}
