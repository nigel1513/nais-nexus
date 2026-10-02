"use client";
import {
  Badge, Button, buttonClass, DataTable, EmptyState, Input, SegmentedControl, Select, Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle,
  Skeleton, Tag, type DataColumn,
} from "@nais/ui";
import { List, Search, SearchX, SlidersHorizontal, Table2 } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { asApiError, fieldErrors } from "@/shared/api/errors";
import { flattenPages } from "@/shared/api/pagination";
import type { DatasetSearchHit, SearchPage } from "@/shared/api/types";
import { hasOrgRole, useMeData } from "@/shared/hooks/use-me";
import { useUrlText } from "@/shared/hooks/use-url-text";
import { useUrlQuery } from "@/shared/hooks/use-url-query";
import { PageHeader } from "@/shared/ui/page-header";
import { ErrorView, LoadMore } from "@/shared/ui/state-views";
import { DateTime } from "@/shared/ui/date-text";
import { useSearchDatasets, type SearchQuery } from "./api";
import { PeriodFilter } from "./components/period-filter";
import { PrincipalInvestigatorFilter } from "./components/principal-investigator-filter";
import { bucketsOf, FACETS, FacetGroup, useFacetLabel, type FacetKey } from "./components/facet-panel";
import { ListReadinessBadge, periodText, SearchResultCard } from "./components/search-result-card";

type Sort = "relevance" | "updated_desc" | "title_asc";
const SORTS: Sort[] = ["relevance", "updated_desc", "title_asc"];
type View = "list" | "table";

/** Rail order (spec §6): classification trees first, then organizations, period, people, access and readiness. */
const RAIL_BEFORE_PERIOD: FacetKey[] = ["subject", "material", "method", "owner_organization_id", "collecting_organization_id"];
const RAIL_AFTER_PI: FacetKey[] = ["access_level", "readiness_status", "purpose", "keyword"];
const URL_FILTERS = ["temporal_from", "temporal_to", "principal_investigator_id", ...FACETS];

export function DataSearchScreen() {
  const t = useTranslations();
  const me = useMeData();
  const facetLabel = useFacetLabel();
  const [params, setParams] = useUrlQuery();
  // The URL is the source of truth for filters, so Back/Forward re-derives them (M10 §7.4).
  const [q, setQ, debounced] = useUrlText("q", params, setParams);
  const sortParam = params.get("sort") as Sort | null;
  const sort: Sort = sortParam && SORTS.includes(sortParam) ? sortParam : "relevance";
  const view: View = params.get("view") === "table" ? "table" : "list";
  const selected = Object.fromEntries(FACETS.map((k) => [k, params.getAll(k)])) as Record<FacetKey, string[]>;
  const [sheetOpen, setSheetOpen] = useState(false);
  // The URL keeps only the PI's id; the name of the person picked in this session labels the chip.
  const [piName, setPiName] = useState<string | null>(null);

  const temporalFrom = params.get("temporal_from") ?? "";
  const temporalTo = params.get("temporal_to") ?? "";
  const piId = params.get("principal_investigator_id") ?? "";

  const query: SearchQuery = {
    ...(temporalFrom ? { temporal_from: temporalFrom } : {}),
    ...(temporalTo ? { temporal_to: temporalTo } : {}),
    ...(piId ? { principal_investigator_id: piId } : {}),
    ...(debounced ? { q: debounced } : {}),
    ...(sort !== "relevance" ? { sort } : {}),
    ...Object.fromEntries(FACETS.filter((k) => selected[k].length).map((k) => [k, selected[k]])),
  };
  const search = useSearchDatasets(query);
  const first = search.data?.pages[0] as SearchPage | undefined;
  const hits = flattenPages(search.data);

  // A hand-edited URL can carry an inverted range; the server's 422 TEMPORAL_RANGE is a field error, not a crash.
  const temporalInvalid = (() => {
    if (!search.isError) return false;
    const err = asApiError(search.error);
    return err.code === "VALIDATION_FAILED" && Object.values(fieldErrors(err)).includes("TEMPORAL_RANGE");
  })();

  const toggle = (key: FacetKey, value: string) => {
    const next = selected[key].includes(value) ? selected[key].filter((v) => v !== value) : [...selected[key], value];
    setParams({ [key]: next });
  };
  const clearFilters = () => setParams(Object.fromEntries(URL_FILTERS.map((k) => [k, null])));
  const reset = () => {
    setQ("");
    setParams(Object.fromEntries(["q", "sort", ...URL_FILTERS].map((k) => [k, null])));
  };
  const activeCount = FACETS.reduce((n, k) => n + selected[k].length, 0) + (temporalFrom || temporalTo ? 1 : 0) + (piId ? 1 : 0);

  const rail = (
    <div className="flex flex-col gap-4">
      {RAIL_BEFORE_PERIOD.map((key) => (
        <FacetGroup key={key} facetKey={key} buckets={bucketsOf(first?.facets, key, selected[key])} selected={selected[key]} onToggle={toggle} />
      ))}
      <PeriodFilter from={temporalFrom} to={temporalTo} serverInvalid={temporalInvalid} onApply={(f, e) => setParams({ temporal_from: f || null, temporal_to: e || null })} />
      <PrincipalInvestigatorFilter
        value={piId}
        onPick={(id, name) => {
          setPiName(name);
          setParams({ principal_investigator_id: id });
        }}
      />
      {RAIL_AFTER_PI.map((key) => (
        <FacetGroup key={key} facetKey={key} buckets={bucketsOf(first?.facets, key, selected[key])} selected={selected[key]} onToggle={toggle} />
      ))}
    </div>
  );
  const railHeader = (
    <div className="flex h-8 items-center justify-between">
      <h2 className="text-body font-semibold text-fg">{t("data.search.filters")}</h2>
      {activeCount ? (
        <Button size="sm" variant="ghost" onClick={clearFilters} className="-mr-2.5">
          {t("data.search.clearAll")}
        </Button>
      ) : null}
    </div>
  );

  return (
    <>
      <PageHeader
        title={t("data.search.title")}
        description={t("data.search.description")}
        actions={
          hasOrgRole(me, "DATA_STEWARD") ? (
            <Link href="/commons/data/new" className={buttonClass("primary")}>
              {t("data.new.title")}
            </Link>
          ) : null
        }
      />
      <div className="grid gap-8 md:grid-cols-[240px_minmax(0,1fr)]">
        <aside aria-label={t("data.search.filters")} className="hidden min-w-0 flex-col gap-4 md:flex">
          {railHeader}
          {rail}
        </aside>

        <section aria-label={t("data.search.results")} className="flex min-w-0 flex-col">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-80">
              <label htmlFor="data-search" className="sr-only">
                {t("shell.searchLabel")}
              </label>
              <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-muted" strokeWidth={1.75} />
              <Input id="data-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("shell.searchPlaceholder")} className="pl-8" />
            </div>
            <Button className="md:hidden" onClick={() => setSheetOpen(true)}>
              <SlidersHorizontal aria-hidden="true" strokeWidth={1.75} />
              {t("data.search.openFilters")}
              {activeCount ? (
                <Badge tone="accent" className="num">
                  {activeCount}
                </Badge>
              ) : null}
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <p aria-live="polite" className="num mr-1 whitespace-nowrap text-small text-fg-muted">
                {first ? t("data.search.total", { count: first.total }) : ""}
              </p>
              <label htmlFor="data-sort" className="sr-only">
                {t("data.search.sort")}
              </label>
              <Select
                id="data-sort"
                value={sort}
                className="w-32"
                onChange={(e) => {
                  const v = e.target.value as Sort;
                  setParams({ sort: v === "relevance" ? null : v });
                }}
              >
                {SORTS.map((s) => (
                  <option key={s} value={s}>
                    {t(`data.search.sortOptions.${s}`)}
                  </option>
                ))}
              </Select>
              <SegmentedControl
                aria-label={t("data.search.view")}
                value={view}
                onValueChange={(v) => setParams({ view: v === "table" ? "table" : null })}
                items={[
                  { value: "list", label: <span className="max-sm:sr-only">{t("data.search.viewList")}</span>, icon: <List aria-hidden="true" strokeWidth={1.75} /> },
                  { value: "table", label: <span className="max-sm:sr-only">{t("data.search.viewTable")}</span>, icon: <Table2 aria-hidden="true" strokeWidth={1.75} /> },
                ]}
              />
            </div>
          </div>

          <ActiveFilters
            chips={[
              ...FACETS.flatMap((key) =>
                selected[key].map((value) => {
                  const bucket = first?.facets?.[key]?.find((b) => b.value === value);
                  return { id: `${key}:${value}`, label: facetLabel(key, value, bucket?.label), onRemove: () => toggle(key, value) };
                }),
              ),
              ...(temporalFrom || temporalTo
                ? [{ id: "period", label: t("data.search.periodChip", { from: temporalFrom || "…", to: temporalTo || "…" }), onRemove: () => setParams({ temporal_from: null, temporal_to: null }) }]
                : []),
              ...(piId
                ? [
                    {
                      id: "pi",
                      label: piName ? t("data.search.pi.selected", { name: piName }) : t("data.search.pi.selectedUnknown"),
                      removeLabel: t("data.search.pi.clear"),
                      onRemove: () => {
                        setPiName(null);
                        setParams({ principal_investigator_id: null });
                      },
                    },
                  ]
                : []),
            ]}
          />

          <div className="mt-4">
            {search.isPending ? (
              <ResultsSkeleton />
            ) : temporalInvalid ? (
              <p role="status" className="border-y border-border px-3 py-6 text-small text-fg-muted">
                {t("data.search.periodInvalidHint")}
              </p>
            ) : search.isError ? (
              <ErrorView error={search.error} onRetry={() => void search.refetch()} />
            ) : hits.length === 0 ? (
              <EmptyState
                icon={SearchX}
                title={t("data.search.empty")}
                description={t("data.search.emptyHint")}
                className="rounded-md border border-border"
                action={<Button onClick={reset}>{t("data.search.reset")}</Button>}
              />
            ) : view === "table" ? (
              <ResultsTable hits={hits} />
            ) : (
              <ul className="divide-y divide-border border-y border-border">
                {hits.map((hit) => (
                  <li key={hit.dataset_id}>
                    <SearchResultCard hit={hit} showSnippet={!!debounced} />
                  </li>
                ))}
              </ul>
            )}
          </div>
          <LoadMore hasNextPage={search.hasNextPage} isFetchingNextPage={search.isFetchingNextPage} fetchNextPage={search.fetchNextPage} />
        </section>
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent closeLabel={t("common.close")}>
          <SheetHeader className="flex-row items-center justify-between gap-2">
            <SheetTitle>{t("data.search.filters")}</SheetTitle>
            {activeCount ? (
              <Button size="sm" variant="ghost" onClick={clearFilters}>
                {t("data.search.clearAll")}
              </Button>
            ) : null}
          </SheetHeader>
          <SheetBody>
            <aside aria-label={t("data.search.filters")} className="flex flex-col gap-3">
              {rail}
            </aside>
          </SheetBody>
        </SheetContent>
      </Sheet>
    </>
  );
}

function ActiveFilters({ chips }: { chips: { id: string; label: string; removeLabel?: string; onRemove: () => void }[] }) {
  const t = useTranslations();
  if (!chips.length) return null;
  return (
    <ul aria-label={t("data.search.activeFilters")} className="mt-3 flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <li key={c.id}>
          <Tag onRemove={c.onRemove} removeLabel={c.removeLabel ?? t("data.search.removeFilter", { label: c.label })}>
            {c.label}
          </Tag>
        </li>
      ))}
    </ul>
  );
}

function ResultsTable({ hits }: { hits: DatasetSearchHit[] }) {
  const t = useTranslations();
  const columns: DataColumn<DatasetSearchHit>[] = [
    {
      key: "title",
      header: t("data.search.column.title"),
      className: "max-w-0 w-full",
      cell: (h) => (
        <Link href={`/commons/data/${h.dataset_id}`} className="block truncate font-medium text-fg hover:underline hover:underline-offset-4" title={h.title}>
          {h.title}
        </Link>
      ),
    },
    { key: "org", header: t("data.search.column.organization"), className: "whitespace-nowrap", cell: (h) => h.owner_organization_name ?? h.owner_organization_id },
    { key: "period", header: t("data.search.column.period"), className: "num whitespace-nowrap", cell: (h) => periodText(h, t("data.search.meta.ongoing")) ?? "—" },
    { key: "updated", header: t("data.search.column.updated"), numeric: true, cell: (h) => <DateTime value={h.updated_at} dateOnly /> },
    { key: "ready", header: t("data.search.column.aiReady"), className: "whitespace-nowrap", cell: (h) => <ListReadinessBadge value={h.readiness_overall} /> },
  ];
  // Same frame as the list: a top and bottom rule, no side borders or rounded box (the primitive's frame is
  // overridden from here; packages/ui stays as is).
  return (
    <div className="[&>div>[role=region]]:rounded-none [&>div>[role=region]]:border-x-0 [&>div>[role=region]]:bg-transparent [&>ul]:rounded-none [&>ul]:border-x-0 [&>ul]:bg-transparent">
      <DataTable caption={t("data.search.results")} columns={columns} rows={hits} rowKey={(h) => h.dataset_id} dense stickyHeader />
    </div>
  );
}

/** Row-shaped placeholders, shown only if loading takes ≥300ms (M10 §7 — no flicker). */
function ResultsSkeleton() {
  const t = useTranslations();
  const [show, setShow] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setShow(true), 300);
    return () => clearTimeout(id);
  }, []);
  return (
    <div role="status" aria-label={t("common.loading")} className="divide-y divide-border border-y border-border">
      {show
        ? Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex flex-col gap-2 px-3 py-4">
              <div className="flex justify-between gap-4">
                <Skeleton className="h-5 w-2/5" />
                <Skeleton className="h-5 w-28" />
              </div>
              <Skeleton className="h-4 w-3/5" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ))
        : null}
    </div>
  );
}
