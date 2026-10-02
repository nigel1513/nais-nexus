"use client";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { Dataset, DatasetVersion } from "@/shared/api/types";
import { formatBytes, formatDate } from "@/shared/lib/format";
import { DefList } from "./def-list";

/** Rail 활동: published version count, last publish, file count and size of the latest version. */
export function ActivitySummary({ versions, dataset: d }: { versions: Pick<DatasetVersion, "status" | "published_at">[]; dataset?: Pick<Dataset, "stats"> }) {
  const t = useTranslations();
  const published = versions.filter((v) => v.status === "PUBLISHED");
  const last = published
    .map((v) => v.published_at)
    .filter((p): p is string => !!p)
    .sort()
    .at(-1);
  const rows: [string, ReactNode][] = [
    [t("data.card.actVersions"), <span key="v" className="num">{published.length}</span>],
    [t("data.card.actLastPublished"), <span key="p" className="num">{last ? formatDate(last) : "—"}</span>],
  ];
  if (d?.stats?.file_count !== undefined) rows.push([t("data.card.actFiles"), <span key="f" className="num">{d.stats.file_count}</span>]);
  if (d?.stats?.total_bytes !== undefined) rows.push([t("data.card.actSize"), <span key="s" className="num">{formatBytes(d.stats.total_bytes)}</span>]);
  return <DefList rows={rows} />;
}
