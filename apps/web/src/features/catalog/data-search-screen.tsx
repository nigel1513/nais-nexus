"use client";
import { Button, buttonClass, EmptyState, Select } from "@nais/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { asApiError, fieldErrors } from "@/shared/api/errors";
import { flattenPages } from "@/shared/api/pagination";
import type { SearchPage } from "@/shared/api/types";
import { hasOrgRole, useMeData } from "@/shared/hooks/use-me";
import { useUrlText } from "@/shared/hooks/use-url-text";
import { useUrlQuery } from "@/shared/hooks/use-url-query";
import { PageHeader } from "@/shared/ui/page-header";
import { DelayedSkeleton, ErrorView, LoadMore } from "@/shared/ui/state-views";
import { useSearchDatasets, type SearchQuery } from "./api";
import { PeriodFilter } from "./components/period-filter";
import { PrincipalInvestigatorFilter } from "./components/principal-investigator-filter";
import { FACETS, FacetPanel, type FacetKey } from "./components/facet-panel";
import { SearchResultCard } from "./components/search-result-card";

type Sort = "relevance" | "updated_desc" | "title_asc";
const SORTS: Sort[] = ["relevance", "updated_desc", "title_asc"];

export function DataSearchScreen() {
  const t = useTranslations();
  const me = useMeData();
  const [params, setParams] = useUrlQuery();
  // The URL is the source of truth for filters, so Back/Forward re-derives them (M10 §7.4).
  const [q, setQ, debounced] = useUrlText("q", params, setParams);
  const sortParam = params.get("sort") as Sort | null;
  const sort: Sort = sortParam && SORTS.includes(sortParam) ? sortParam : "relevance";
  const selected = Object.fromEntries(FACETS.map((k) => [k, params.getAll(k)])) as Record<FacetKey, string[]>;

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
  const reset = () => {
    setQ("");
    setParams(Object.fromEntries(["q", "sort", "temporal_from", "temporal_to", "principal_investigator_id", ...FACETS].map((k) => [k, null])));
  };

  return (
    <>
      <PageHeader
        title={t("data.search.title")}
        actions={
          hasOrgRole(me, "DATA_STEWARD") ? (
            <Link href="/commons/data/new" className={buttonClass("primary")}>
              {t("data.new.title")}
            </Link>
          ) : null
        }
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-60 flex-1">
          <label htmlFor="data-search" className="sr-only">
            {t("shell.searchLabel")}
          </label>
          <input
            id="data-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("shell.searchPlaceholder")}
            className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
          />
        </div>
        <div>
          <label htmlFor="data-sort" className="sr-only">
            {t("data.search.sort")}
          </label>
          <Select
            id="data-sort"
            value={sort}
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
        </div>
      </div>
      <div className="grid gap-6 md:grid-cols-[16rem_1fr]">
        <div className="flex flex-col gap-4">
          <PeriodFilter from={temporalFrom} to={temporalTo} serverInvalid={temporalInvalid} onApply={(f, e) => setParams({ temporal_from: f || null, temporal_to: e || null })} />
          <PrincipalInvestigatorFilter value={piId} onChange={(id) => setParams({ principal_investigator_id: id })} />
          <FacetPanel facets={first?.facets} selected={selected} onToggle={toggle} />
        </div>
        <section aria-labelledby="data-results" className="flex min-w-0 flex-col gap-3">
          <h2 id="data-results" className="sr-only">
            {t("data.search.results")}
          </h2>
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {first ? t("data.search.total", { count: first.total }) : ""}
          </p>
          {search.isPending ? (
            <DelayedSkeleton lines={5} />
          ) : temporalInvalid ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t("data.search.periodInvalidHint")}
            </p>
          ) : search.isError ? (
            <ErrorView error={search.error} onRetry={() => void search.refetch()} />
          ) : hits.length === 0 ? (
            <EmptyState
              title={t("data.search.empty")}
              action={
                <Button variant="outline" onClick={reset}>
                  {t("data.search.reset")}
                </Button>
              }
            />
          ) : (
            hits.map((hit) => <SearchResultCard key={hit.dataset_id} hit={hit} />)
          )}
          <LoadMore hasNextPage={search.hasNextPage} isFetchingNextPage={search.isFetchingNextPage} fetchNextPage={search.fetchNextPage} />
        </section>
      </div>
    </>
  );
}
