"use client";
import { Checkbox } from "@nais/ui";
import { useLocale, useTranslations } from "next-intl";
import type { VocabularyScheme, VocabularyTerm } from "@/shared/api/types";
import { useListVocabulary } from "../api";

/** Checkbox list of a vocabulary scheme; children are indented under their parent. Beyond `max` the unchecked boxes are disabled. */
export function VocabularyPicker({
  id,
  scheme,
  legend,
  max,
  value,
  onChange,
  error,
}: {
  id?: string;
  scheme: VocabularyScheme;
  legend: string;
  max: number;
  value: string[];
  onChange: (codes: string[]) => void;
  error?: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const terms = useListVocabulary(scheme);
  const items = terms.data?.items ?? [];
  const label = (x: VocabularyTerm) => (locale === "en" ? x.label_en : x.label_ko);
  const roots = items.filter((x) => !x.parent_code || !items.some((p) => p.code === x.parent_code));
  const full = value.length >= max;
  const box = (x: VocabularyTerm, indent: boolean) => (
    <label key={x.code} className={`flex items-center gap-2 text-sm ${indent ? "ml-6" : ""}`}>
      <Checkbox
        checked={value.includes(x.code)}
        disabled={full && !value.includes(x.code)}
        onChange={(e) => onChange(e.target.checked ? [...value, x.code] : value.filter((c) => c !== x.code))}
      />
      {label(x)}
    </label>
  );
  return (
    <fieldset id={id} className="flex flex-col gap-1" aria-describedby={error ? `${id}-error` : undefined}>
      <legend className="mb-1 text-sm font-medium">
        {legend} <span className="font-normal text-muted-foreground">{t("data.form.maxCount", { max })}</span>
      </legend>
      {terms.isPending ? <p className="text-xs text-muted-foreground">{t("common.loading")}</p> : null}
      {roots.map((r) => (
        <div key={r.code} className="flex flex-col gap-1">
          {box(r, false)}
          {items.filter((c) => c.parent_code === r.code).map((c) => box(c, true))}
        </div>
      ))}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
