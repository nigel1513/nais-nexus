"use client";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { Dataset } from "@/shared/api/types";
import { VocabularyTags } from "../components/vocabulary-tags";
import { RailPanel } from "./side-card";

/**
 * 한눈에: the short facts beside About — vocabulary tags and one-line values only. Long metadata (people, provenance,
 * method detail, usage terms) lives in the metadata panels below. Same panel language as the rail.
 */
export function FactsPanel({ dataset: d }: { dataset: Dataset }) {
  const t = useTranslations();
  const rows: [string, ReactNode][] = [];
  if (d.subject_codes?.length) rows.push([t("data.meta.subjects"), <VocabularyTags key="s" scheme="SUBJECT" codes={d.subject_codes} />]);
  if (d.material_codes?.length) rows.push([t("data.meta.materials"), <VocabularyTags key="m" scheme="MATERIAL" codes={d.material_codes} />]);
  if (d.method_codes?.length) rows.push([t("data.meta.methods"), <VocabularyTags key="x" scheme="METHOD" codes={d.method_codes} />]);
  if (d.collecting_organization?.name) rows.push([t("data.meta.collectingOrg"), d.collecting_organization.name]);
  if (d.update_frequency) rows.push([t("data.meta.updateFrequency"), t(`enums.UpdateFrequency.${d.update_frequency}`)]);
  rows.push([t("data.meta.license"), <span key="l" className="font-mono text-mono">{d.license}</span>]);
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <RailPanel title={t("data.card.factsTitle")}>
        <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2.5 text-small sm:max-xl:grid-cols-[5.5rem_minmax(0,1fr)_5.5rem_minmax(0,1fr)]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-fg-muted">{k}</dt>
              <dd className="min-w-0 break-keep text-fg">{v}</dd>
            </div>
          ))}
        </dl>
      </RailPanel>
    </div>
  );
}
