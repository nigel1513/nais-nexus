"use client";
import { Checkbox, Input, Popover, PopoverContent, PopoverTitle, PopoverTrigger, Tag, buttonClass, cn } from "@nais/ui";
import { CircleAlert, Plus, Search } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useId, useState } from "react";
import type { VocabularyScheme, VocabularyTerm } from "@/shared/api/types";
import { useListVocabulary } from "../api";

/**
 * Vocabulary multi-select (spec §4 VocabularyPicker): chosen terms are removable Tags, the add button opens a popover
 * with a search box and the scheme as a tree (children indented under their parent). At `max` the unchecked boxes are
 * disabled and the popover says so.
 */
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
  const autoId = useId();
  const baseId = id ?? autoId;
  const legendId = `${baseId}-legend`;
  const terms = useListVocabulary(scheme);
  const [query, setQuery] = useState("");
  const items = terms.data?.items ?? [];
  const label = (x: VocabularyTerm) => (locale === "en" ? x.label_en : x.label_ko);
  const byCode = new Map(items.map((x) => [x.code, x]));
  const roots = items.filter((x) => !x.parent_code || !byCode.has(x.parent_code));
  const q = query.trim().toLowerCase();
  const hit = (x: VocabularyTerm) => !q || x.label_ko.toLowerCase().includes(q) || x.label_en.toLowerCase().includes(q) || x.code.toLowerCase().includes(q);
  const full = value.length >= max;
  const toggle = (code: string, on: boolean) => onChange(on ? [...value, code] : value.filter((c) => c !== code));

  const row = (x: VocabularyTerm, child: boolean) => {
    const checked = value.includes(x.code);
    return (
      <li key={x.code}>
        <label
          className={cn(
            "flex h-8 cursor-pointer select-none items-center gap-2 rounded-sm px-2 text-body text-fg",
            "hover:bg-bg-hover has-[:disabled]:cursor-not-allowed has-[:disabled]:text-fg-subtle has-[:disabled]:hover:bg-transparent",
            child && "pl-8",
          )}
        >
          <Checkbox checked={checked} disabled={full && !checked} onChange={(e) => toggle(x.code, e.target.checked)} />
          <span className="min-w-0 flex-1 truncate">{label(x)}</span>
        </label>
      </li>
    );
  };

  const tree = roots.flatMap((r) => {
    const shownKids = items.filter((c) => c.parent_code === r.code && (hit(c) || hit(r)));
    if (!hit(r) && !shownKids.length) return [];
    return [row(r, false), ...shownKids.map((c) => row(c, true))];
  });

  return (
    <div id={id} role="group" aria-labelledby={legendId} aria-describedby={error ? `${baseId}-error` : undefined} className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span id={legendId} className="text-small font-medium text-fg">
          {legend}
        </span>
        <span className="num text-caption font-normal text-fg-muted">
          {value.length} / {max}
        </span>
      </div>
      <div className="flex min-h-8 flex-wrap items-center gap-1.5">
        {value.map((code) => {
          const term = byCode.get(code);
          const name = term ? label(term) : code;
          return (
            <Tag key={code} onRemove={() => toggle(code, false)} removeLabel={t("data.form.vocabRemove", { name })}>
              {name}
            </Tag>
          );
        })}
        <Popover onOpenChange={(o) => !o && setQuery("")}>
          <PopoverTrigger className={buttonClass("ghost", "sm", "border border-dashed border-border-strong")} aria-label={t("data.form.vocabOpen", { legend })}>
            <Plus aria-hidden="true" strokeWidth={1.75} />
            {value.length ? t("data.form.vocabEdit") : t("data.form.vocabChoose")}
          </PopoverTrigger>
          <PopoverContent className="flex w-80 flex-col p-0">
            <div className="flex flex-col gap-2 border-b border-border p-2">
              <PopoverTitle className="px-1 pt-1 text-small font-semibold">{legend}</PopoverTitle>
              <div className="relative">
                <Search aria-hidden="true" strokeWidth={1.75} className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-muted" />
                <Input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label={t("data.form.vocabSearch", { legend })}
                  placeholder={t("data.form.vocabSearchPlaceholder")}
                  className="pl-8"
                />
              </div>
            </div>
            <div className="max-h-72 overflow-y-auto p-1">
              {terms.isPending ? <p className="px-2 py-1.5 text-small text-fg-muted">{t("common.loading")}</p> : null}
              {!terms.isPending && !tree.length ? <p className="px-2 py-1.5 text-small text-fg-muted">{t("data.form.vocabNoMatch")}</p> : null}
              <ul aria-label={legend}>{tree}</ul>
            </div>
            <p role="status" className={cn("flex items-center gap-1.5 border-t border-border px-3 py-2 text-caption font-normal", full ? "text-warning" : "text-fg-muted")}>
              {full ? <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={2} /> : null}
              <span className="num">{t("data.form.vocabCount", { count: value.length, max })}</span>
              <span aria-hidden="true">·</span>
              <span>{full ? t("data.form.vocabFull", { max }) : t("data.form.maxCount", { max })}</span>
            </p>
          </PopoverContent>
        </Popover>
      </div>
      {error ? (
        <p id={`${baseId}-error`} className="flex items-start gap-1.5 text-small text-danger">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
          {error}
        </p>
      ) : null}
    </div>
  );
}
