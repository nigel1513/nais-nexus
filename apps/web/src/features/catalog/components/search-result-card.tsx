"use client";
import { Tag } from "@nais/ui";
import { Building2, CalendarRange, Clock, FlaskConical, Layers, UserRound, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { DatasetSearchHit } from "@/shared/api/types";
import { AccessLevelBadge, ReadinessBadge } from "@/shared/ui/badges";
import { DateTime } from "@/shared/ui/date-text";
import { useVocabularyLabels } from "../api";

export function periodText(hit: DatasetSearchHit, ongoing: string): string | null {
  return hit.temporal_start ? `${hit.temporal_start} – ${hit.temporal_end ?? ongoing}` : null;
}

/** `label` is read by screen readers before the value; omit it when the value already says what it is. */
function Meta({ icon: Icon, label, children }: { icon: LucideIcon; label?: string; children: ReactNode }) {
  return (
    <li className="flex min-w-0 items-center gap-1.5">
      <Icon aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={1.75} />
      {label ? <span className="sr-only">{label} </span> : null}
      {children}
    </li>
  );
}

/**
 * One search result as a list row (spec §6): title 16/600, subtitle, a meta line (organization · PI · period ·
 * version · updated) and the access / AI-Ready badges on the right. The whole row opens the dataset.
 */
export function SearchResultCard({ hit, showSnippet = false }: { hit: DatasetSearchHit; showSnippet?: boolean }) {
  const t = useTranslations();
  const vocab = useVocabularyLabels();
  const period = periodText(hit, t("data.search.meta.ongoing"));
  const collecting = hit.collecting_organization_name && hit.collecting_organization_name !== hit.owner_organization_name ? hit.collecting_organization_name : null;
  const subjects = hit.subject_codes ?? [];
  return (
    <article className="relative flex flex-col gap-1 px-3 py-4 hover:bg-bg-hover has-[a:focus-visible]:bg-bg-hover">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <h2 className="min-w-0 text-heading text-fg">
          <Link
            href={`/commons/data/${hit.dataset_id}`}
            className="break-words outline-none after:absolute after:inset-0 hover:underline hover:underline-offset-4 focus-visible:underline"
          >
            {hit.title}
          </Link>
        </h2>
        <div className="flex shrink-0 flex-wrap gap-1.5 sm:pt-0.5">
          <AccessLevelBadge level={hit.access_level} />
          <ReadinessBadge value={hit.readiness_overall} />
        </div>
      </div>
      {hit.subtitle ? <p className="max-w-[72ch] text-body text-fg">{hit.subtitle}</p> : null}
      {showSnippet && hit.snippet ? <p className="line-clamp-2 max-w-[72ch] text-small text-fg-muted">{hit.snippet}</p> : null}
      <ul aria-label={t("data.search.metaLabel")} className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-small text-fg-muted">
        <Meta icon={Building2} label={t("data.search.meta.owner")}>
          <span className="truncate">{hit.owner_organization_name ?? hit.owner_organization_id}</span>
        </Meta>
        {hit.principal_investigator_name ? (
          <Meta icon={UserRound} label={t("data.search.meta.pi")}>
            <span className="truncate">{hit.principal_investigator_name}</span>
          </Meta>
        ) : null}
        {period ? (
          <Meta icon={CalendarRange} label={t("data.search.meta.period")}>
            <span className="num">{period}</span>
          </Meta>
        ) : null}
        {hit.latest_version_label ? (
          <Meta icon={Layers} label={t("data.search.meta.version")}>
            <span className="font-mono text-mono text-fg">{hit.latest_version_label}</span>
          </Meta>
        ) : null}
        {collecting ? (
          <Meta icon={FlaskConical}>
            <span className="truncate">
              {t("data.search.meta.collecting")} {collecting}
            </span>
          </Meta>
        ) : null}
        {hit.updated_at ? (
          <Meta icon={Clock} label={t("data.search.meta.updated")}>
            <span className="num">
              <DateTime value={hit.updated_at} dateOnly />
            </span>
          </Meta>
        ) : null}
      </ul>
      {subjects.length ? (
        <ul className="mt-1.5 flex flex-wrap gap-1">
          {subjects.map((code) => (
            <li key={code}>
              <Tag>{vocab("SUBJECT", code)}</Tag>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}
