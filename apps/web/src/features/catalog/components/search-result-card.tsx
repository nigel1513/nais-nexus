"use client";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { DatasetSearchHit } from "@/shared/api/types";
import { AccessLevelBadge, ReadinessBadge } from "@/shared/ui/badges";
import { DateTime } from "@/shared/ui/date-text";

export function SearchResultCard({ hit }: { hit: DatasetSearchHit }) {
  const t = useTranslations();
  return (
    <article className="flex flex-col gap-2 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="text-lg font-semibold">
          <Link href={`/commons/data/${hit.dataset_id}`} className="underline-offset-4 hover:underline">
            {hit.title}
          </Link>
        </h2>
        <div className="flex flex-wrap gap-1">
          <AccessLevelBadge level={hit.access_level} />
          <ReadinessBadge value={hit.readiness_overall} />
        </div>
      </div>
      {hit.snippet ? <p className="text-sm text-muted-foreground">{hit.snippet}</p> : null}
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <div>
          <dt className="inline">{t("data.search.owner")}: </dt>
          <dd className="inline">{hit.owner_organization_name ?? hit.owner_organization_id}</dd>
        </div>
        <div>
          <dt className="inline">{t("data.search.purposes")}: </dt>
          <dd className="inline">{(hit.allowed_purposes ?? []).map((p) => t(`enums.Purpose.${p}`)).join(", ") || "—"}</dd>
        </div>
        <div>
          <dt className="inline">{t("data.search.latestVersion")}: </dt>
          <dd className="inline">{hit.latest_version_label ?? "—"}</dd>
        </div>
        <div>
          <dt className="inline">{t("data.search.updated")}: </dt>
          <dd className="inline">
            <DateTime value={hit.updated_at} dateOnly />
          </dd>
        </div>
      </dl>
    </article>
  );
}
