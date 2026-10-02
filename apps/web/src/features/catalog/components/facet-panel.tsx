"use client";
import { Checkbox, cn } from "@nais/ui";
import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState, type ReactNode } from "react";
import type { FacetBucket, SearchPage, VocabularyScheme } from "@/shared/api/types";
import { useListVocabulary, useVocabularyLabels } from "../api";

export const FACETS = ["access_level", "owner_organization_id", "purpose", "keyword", "readiness_status", "subject", "material", "method", "collecting_organization_id"] as const;
export type FacetKey = (typeof FACETS)[number];

const ENUM_OF: Partial<Record<FacetKey, string>> = { access_level: "AccessLevel", purpose: "Purpose", readiness_status: "ReadinessOverall" };
const SCHEME_OF: Partial<Record<FacetKey, VocabularyScheme>> = { subject: "SUBJECT", material: "MATERIAL", method: "METHOD" };

/** Top-level rows shown before "N개 더 보기"; a row holding a selected value is always shown. */
const VISIBLE = 5;

/** Long, secondary groups start closed unless they hold a selection. */
const CLOSED_BY_DEFAULT: FacetKey[] = ["material", "method", "purpose", "keyword", "collecting_organization_id"];

/** `(facet, value, bucket label?) => display label`, shared by facet rows and active-filter chips. */
export function useFacetLabel() {
  const t = useTranslations();
  const vocab = useVocabularyLabels();
  return (key: FacetKey, value: string, label?: string) => {
    const e = ENUM_OF[key];
    if (e) return t(`enums.${e}.${value}`);
    const scheme = SCHEME_OF[key];
    if (scheme) return vocab(scheme, value);
    return label ?? value;
  };
}

/** Facet buckets plus selected values the server no longer counts: they stay visible and toggleable at 0. */
export function bucketsOf(facets: SearchPage["facets"] | undefined, key: FacetKey, selected: string[]): FacetBucket[] {
  const found = facets?.[key] ?? [];
  return [...found, ...selected.filter((v) => !found.some((b) => b.value === v)).map((value) => ({ value, count: 0 }))];
}

/**
 * Rail section: a 12/500 muted title over its content with a hairline above. The title is a disclosure button, so
 * long or rarely used groups can start closed without leaving the rail.
 */
export function RailSection({ title, children, defaultOpen = true, className }: { title: string; children: ReactNode; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <fieldset className={cn("min-w-0 border-t border-border pt-2", className)}>
      <legend className="float-left w-full">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((o) => !o)}
          className="flex h-7 w-full cursor-pointer items-center justify-between rounded-sm text-small font-semibold text-fg outline-none hover:text-accent-fg focus-visible:outline-2 focus-visible:outline-focus"
        >
          {title}
          <ChevronDown aria-hidden="true" strokeWidth={1.75} className={cn("size-3.5 text-fg-muted transition-transform duration-150 ease-[var(--ease-out)]", !open && "-rotate-90")} />
        </button>
      </legend>
      <div id={bodyId} hidden={!open} className="clear-left flex flex-col pb-1 pt-1">
        {children}
      </div>
    </fieldset>
  );
}

type Node = { value: string; bucket: FacetBucket | null; children: Node[] };

/** Vocabulary facets nest a narrower term under its broader one; a broader term without hits is a plain label. */
function useTree(key: FacetKey, buckets: FacetBucket[]): Node[] {
  const scheme = SCHEME_OF[key];
  // Non-vocabulary facets keep the hook order but never subscribe to a vocabulary.
  const terms = useListVocabulary(scheme ?? "SUBJECT", !!scheme).data?.items ?? [];
  if (!scheme) return buckets.map((b) => ({ value: b.value, bucket: b, children: [] }));
  const parentOf = (code: string) => {
    const parent = terms.find((x) => x.code === code)?.parent_code ?? null;
    return parent && terms.some((x) => x.code === parent) ? parent : null;
  };
  const nodes = new Map<string, Node>();
  const nodeFor = (value: string) => {
    let n = nodes.get(value);
    if (!n) nodes.set(value, (n = { value, bucket: null, children: [] }));
    return n;
  };
  const roots: Node[] = [];
  for (const b of buckets) nodeFor(b.value).bucket = b;
  for (const b of buckets) {
    const parent = parentOf(b.value);
    const top = parent ? nodeFor(parent) : nodeFor(b.value);
    if (parent) top.children.push(nodeFor(b.value));
    if (!roots.includes(top)) roots.push(top);
  }
  // A broader term that also has its own bucket was pushed as a root before its children; keep each node once.
  return roots.filter((r) => !roots.some((o) => o.children.includes(r)));
}

export function FacetGroup({
  facetKey,
  buckets,
  selected,
  onToggle,
}: {
  facetKey: FacetKey;
  buckets: FacetBucket[];
  selected: string[];
  onToggle: (key: FacetKey, value: string) => void;
}) {
  const t = useTranslations();
  const label = useFacetLabel();
  const tree = useTree(facetKey, buckets);
  const [expanded, setExpanded] = useState(false);
  if (!buckets.length) return null;

  const hasSelected = (n: Node): boolean => selected.includes(n.value) || n.children.some(hasSelected);
  const shown = expanded ? tree : tree.filter((n, i) => i < VISIBLE || hasSelected(n));
  const hidden = tree.length - shown.length;

  const row = (n: Node) => {
    const name = label(facetKey, n.value, n.bucket?.label);
    if (!n.bucket) return <span className="flex h-7 items-center truncate pl-6 text-small text-fg-muted">{name}</span>;
    const checked = selected.includes(n.value);
    return (
      <label className="-mx-1.5 flex h-7 cursor-pointer items-center gap-2 rounded-sm px-1.5 text-small text-fg hover:bg-bg-hover">
        <Checkbox
          id={`facet-${facetKey}-${n.value}`}
          checked={checked}
          aria-label={t("data.search.facetOption", { label: name, count: n.bucket.count })}
          onChange={() => onToggle(facetKey, n.value)}
        />
        <span className={cn("min-w-0 flex-1 truncate", checked && "font-medium")}>{name}</span>
        <span aria-hidden="true" className="num shrink-0 text-caption text-fg-muted">
          {n.bucket.count.toLocaleString("ko-KR")}
        </span>
      </label>
    );
  };
  const list = (nodes: Node[], nested: boolean) => (
    <ul className={cn("flex flex-col", nested && "ml-2 border-l border-border pl-2.5")}>
      {nodes.map((n) => (
        <li key={n.value}>
          {row(n)}
          {n.children.length ? list(n.children, true) : null}
        </li>
      ))}
    </ul>
  );

  return (
    <RailSection title={t(`data.search.facet.${facetKey}`)} defaultOpen={!CLOSED_BY_DEFAULT.includes(facetKey) || selected.length > 0}>
      {list(shown, false)}
      {hidden > 0 || expanded ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
          className="mt-1 h-7 self-start rounded-sm text-small text-accent-fg outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {expanded ? t("data.search.showLess") : t("data.search.showMore", { count: hidden })}
        </button>
      ) : null}
    </RailSection>
  );
}
