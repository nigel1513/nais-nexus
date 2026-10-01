"use client";
import { Checkbox } from "@nais/ui";
import { useTranslations } from "next-intl";
import type { FacetBucket, SearchPage } from "@/shared/api/types";

export const FACETS = ["access_level", "owner_organization_id", "purpose", "keyword", "readiness_status"] as const;
export type FacetKey = (typeof FACETS)[number];

const ENUM_OF: Partial<Record<FacetKey, string>> = { access_level: "AccessLevel", purpose: "Purpose", readiness_status: "ReadinessOverall" };

export function FacetPanel({
  facets,
  selected,
  onToggle,
}: {
  facets: SearchPage["facets"] | undefined;
  selected: Record<FacetKey, string[]>;
  onToggle: (key: FacetKey, value: string) => void;
}) {
  const t = useTranslations();
  const label = (key: FacetKey, b: FacetBucket) => (ENUM_OF[key] ? t(`enums.${ENUM_OF[key]}.${b.value}`) : (b.label ?? b.value));
  return (
    <aside aria-label={t("data.search.filters")} className="flex flex-col gap-4">
      {FACETS.map((key) => {
        const buckets = facets?.[key] ?? [];
        if (!buckets.length && !selected[key].length) return null;
        return (
          <fieldset key={key} className="flex flex-col gap-1">
            <legend className="mb-1 text-sm font-semibold">{t(`data.search.facet.${key}`)}</legend>
            {buckets.map((b) => {
              const id = `facet-${key}-${b.value}`;
              return (
                <div key={b.value} className="flex items-center gap-2 text-sm">
                  <Checkbox id={id} checked={selected[key].includes(b.value)} onChange={() => onToggle(key, b.value)} />
                  <label htmlFor={id}>
                    {label(key, b)} ({b.count})
                  </label>
                </div>
              );
            })}
          </fieldset>
        );
      })}
    </aside>
  );
}
