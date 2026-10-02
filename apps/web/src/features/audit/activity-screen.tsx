"use client";
import { Button, buttonClass, Checkbox, cn, EmptyState, fieldClass, Input, Popover, PopoverContent, PopoverTitle, PopoverTrigger, SelectMenu } from "@nais/ui";
import { ChevronDown, History, Search, SearchX } from "lucide-react";
import { useTranslations } from "next-intl";
import { ENUMS } from "@/generated/contracts";
import { useListProjects } from "@/features/projects/api";
import { flattenPages } from "@/shared/api/pagination";
import type { AuditAction, Query, ResourceType } from "@/shared/api/types";
import { hasOrgRole, useMeData } from "@/shared/hooks/use-me";
import { useUrlQuery } from "@/shared/hooks/use-url-query";
import { formatDate } from "@/shared/lib/format";
import { PageHeader } from "@/shared/ui/page-header";
import { DelayedSkeleton, ErrorView, LoadMore } from "@/shared/ui/state-views";
import { useListAuditEvents } from "./api";
import { searchText, useTargetNames } from "./components/activity-entry";
import { ActivityTimeline } from "./components/audit-timeline";

const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ALL = "ALL";

/** Start of the given Asia/Seoul calendar day as a UTC ISO instant, or null for anything that is not a real date. */
function seoulDayStart(date: string | null): number | null {
  if (!date || !DATE.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00.000+09:00`);
  if (Number.isNaN(ms)) return null;
  // Date rolls impossible days over (2026-02-30 → 03-02); only accept dates that survive the round trip.
  return new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10) === date ? ms : null;
}

const isAction = (v: string): v is AuditAction => (ENUMS.AuditAction as readonly string[]).includes(v);
const isResourceType = (v: string): v is ResourceType => (ENUMS.ResourceType as readonly string[]).includes(v);

/** Action kinds grouped the way people think about them; anything new in the contract lands in "other". */
const ACTION_GROUPS: [string, AuditAction[]][] = [
  ["access", ["ACCESS_REQUESTED", "ACCESS_REVIEW_STARTED", "ACCESS_APPROVED", "ACCESS_REJECTED", "ACCESS_CHANGES_REQUESTED", "ACCESS_WITHDRAWN", "ACCESS_REVOKED", "ACCESS_EXPIRED"]],
  ["download", ["FILE_DOWNLOADED", "DOWNLOAD_DENIED"]],
  ["data", ["DATASET_CREATED", "DATASET_UPDATED", "DATASET_VERSION_PUBLISHED", "POLICY_CHANGED", "READINESS_VALIDATION_COMPLETED"]],
  ["project", ["PROJECT_CREATED", "PROJECT_ARCHIVED", "PROJECT_MEMBER_ADDED", "PROJECT_MEMBER_REMOVED", "PROJECT_MEMBER_ROLE_CHANGED"]],
  ["account", ["LOGIN", "USER_CREATED", "ORGANIZATION_CREATED", "ADMIN_ROLE_CHANGED"]],
];
const GROUPED = new Set(ACTION_GROUPS.flatMap(([, a]) => a));
const OTHER = ENUMS.AuditAction.filter((a) => !GROUPED.has(a));
const groupsWithOther: [string, AuditAction[]][] = OTHER.length ? [...ACTION_GROUPS, ["other", OTHER]] : ACTION_GROUPS;

/** Period presets map onto the URL's from/to (Seoul days); "custom" shows the two date fields. */
const PRESETS = { today: 1, "7d": 7, "30d": 30 } as const;
type Period = "all" | keyof typeof PRESETS | "custom";
const seoulDaysAgo = (n: number) => formatDate(new Date(Date.now() - n * DAY_MS).toISOString());

/**
 * M10 §7.11. The URL is the single source of truth for the filters. Filters only narrow what the server already
 * allows the caller to see (M09 §6); nothing here widens or hides rows, so DOWNLOAD_DENIED appears iff the server sends it.
 * The target search narrows the loaded rows on the client (the API has no text search).
 */
export function ActivityScreen() {
  const t = useTranslations();
  const me = useMeData();
  const [params, setParams] = useUrlQuery();
  const actions = params.getAll("action").filter(isAction);
  const projectId = params.get("project_id") ?? "";
  const resourceTypeParam = params.get("resource_type") ?? "";
  const resourceType = isResourceType(resourceTypeParam) ? resourceTypeParam : "";
  const fromParam = params.get("from");
  const toParam = params.get("to");
  const fromMs = seoulDayStart(fromParam);
  const toMs = seoulDayStart(toParam);
  const text = params.get("q") ?? "";
  const projects = useListProjects({ scope: "mine", limit: 100 });
  const projectList = flattenPages(projects.data);
  const names = useTargetNames();

  const query: Query<"listAuditEvents"> = {
    ...(actions.length ? { action: actions } : {}),
    ...(projectId ? { project_id: projectId } : {}),
    ...(resourceType ? { resource_type: resourceType } : {}),
    ...(fromMs !== null ? { from: new Date(fromMs).toISOString() } : {}),
    // The end date is inclusive for the user; the server's `to` is exclusive, so send the start of the next day.
    ...(toMs !== null ? { to: new Date(toMs + DAY_MS).toISOString() } : {}),
  };
  const q = useListAuditEvents(query);
  const loaded = flattenPages(q.data);
  const needle = text.trim().toLowerCase();
  const rows = needle ? loaded.filter((e) => searchText(e, names, t).includes(needle)) : loaded;
  const scope = me.platform_roles.includes("PLATFORM_ADMIN") ? "platform" : hasOrgRole(me, "ORG_ADMIN", "DATA_STEWARD") ? "org" : "self";

  const preset = (Object.keys(PRESETS) as (keyof typeof PRESETS)[]).find((k) => toMs === null && fromParam === seoulDaysAgo(PRESETS[k] - 1));
  // "직접 지정" lives in the URL too (?period=custom), so Back/Forward and 필터 초기화 restore the select.
  const period: Period = params.get("period") === "custom" ? "custom" : fromMs === null && toMs === null ? "all" : (preset ?? "custom");
  const choosePeriod = (p: string | null) => {
    if (p === "custom") return setParams({ period: "custom" });
    if (!p || p === "all") return setParams({ period: null, from: null, to: null });
    setParams({ period: null, from: seoulDaysAgo(PRESETS[p as keyof typeof PRESETS] - 1), to: null });
  };
  const toggleAction = (a: AuditAction) => setParams({ action: actions.includes(a) ? actions.filter((x) => x !== a) : [...actions, a] });
  const filtered = actions.length > 0 || !!projectId || !!resourceType || fromMs !== null || toMs !== null || !!text;
  const reset = () => setParams({ action: null, project_id: null, resource_type: null, from: null, to: null, q: null, period: null });

  return (
    <>
      <PageHeader title={t("activity.title")} description={t(`activity.scope.${scope}`)} />
      <div role="search" aria-label={t("activity.filter.label")} className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
        <SelectMenu
          aria-label={t("activity.filter.period")}
          className="sm:w-36"
          value={period}
          onValueChange={choosePeriod}
          options={(["all", "today", "7d", "30d", "custom"] as const).map((p) => ({ value: p, label: t(`activity.period.${p}`) }))}
        />
        {period === "custom" ? (
          <span className="col-span-2 flex items-center gap-1.5">
            <Input
              type="date"
              aria-label={t("activity.filter.from")}
              className="sm:w-40"
              value={fromMs !== null ? (fromParam ?? "") : ""}
              onChange={(e) => setParams({ from: e.target.value || null })}
            />
            <span aria-hidden="true" className="text-fg-muted">
              –
            </span>
            <Input type="date" aria-label={t("activity.filter.to")} className="sm:w-40" value={toMs !== null ? (toParam ?? "") : ""} onChange={(e) => setParams({ to: e.target.value || null })} />
          </span>
        ) : null}
        {/* The trigger has the same field look as the SelectMenu triggers beside it. */}
        <Popover>
          <PopoverTrigger
            aria-label={actions.length ? t("activity.filter.actionsCount", { count: actions.length }) : t("activity.filter.actions")}
            className={cn(fieldClass, "flex cursor-pointer items-center justify-between gap-2 text-left sm:w-40")}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate">{t("activity.filter.actions")}</span>
              {actions.length ? <span className="num rounded-sm bg-bg-active px-1.5 text-caption text-fg-muted">{actions.length}</span> : null}
            </span>
            <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-fg-muted" strokeWidth={1.75} />
          </PopoverTrigger>
          <PopoverContent align="start" className="flex w-80 flex-col p-0">
            <div className="flex h-10 shrink-0 items-center border-b border-border pl-3 pr-1">
              <PopoverTitle className="text-small font-medium">{t("activity.filter.actions")}</PopoverTitle>
              {actions.length ? (
                <button type="button" onClick={() => setParams({ action: null })} className={buttonClass("ghost", "sm", "ml-auto")}>
                  {t("activity.filter.clearActions")}
                </button>
              ) : null}
            </div>
            <div className="max-h-[min(var(--available-height),24rem)] overflow-y-auto p-1">
              {groupsWithOther.map(([g, list]) => (
                <fieldset key={g} className="py-1">
                  <legend className="px-2 pb-1 pt-1 text-caption text-fg-muted">{t(`activity.actionGroup.${g}`)}</legend>
                  {list.map((a) => (
                    <label key={a} className="flex h-8 cursor-pointer items-center gap-2 rounded-sm px-2 text-body text-fg hover:bg-bg-hover">
                      <Checkbox checked={actions.includes(a)} onChange={() => toggleAction(a)} />
                      {t(`enums.AuditAction.${a}`)}
                    </label>
                  ))}
                </fieldset>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <SelectMenu
          aria-label={t("activity.filter.resourceType")}
          className="sm:w-40"
          value={resourceType || ALL}
          onValueChange={(v) => setParams({ resource_type: !v || v === ALL ? null : v })}
          options={[{ value: ALL, label: t("activity.filter.allResources") }, ...ENUMS.ResourceType.map((r) => ({ value: r, label: t(`enums.ResourceType.${r}`) }))]}
        />
        <SelectMenu
          aria-label={t("activity.filter.project")}
          className="sm:w-48"
          value={projectId || ALL}
          onValueChange={(v) => setParams({ project_id: !v || v === ALL ? null : v })}
          options={[
            { value: ALL, label: t("activity.filter.allProjects") },
            ...(projectId && !projectList.some((p) => p.project_id === projectId) ? [{ value: projectId, label: projectId.slice(-8) }] : []),
            ...projectList.map((p) => ({ value: p.project_id, label: p.name })),
          ]}
        />
        <label className="relative col-span-2 sm:ml-auto sm:w-60">
          <span className="sr-only">{t("activity.filter.search")}</span>
          <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-muted" strokeWidth={1.75} />
          <Input type="search" className="pl-8" placeholder={t("activity.filter.searchPlaceholder")} value={text} onChange={(e) => setParams({ q: e.target.value || null })} />
        </label>
      </div>
      <div className="mb-2 mt-3 flex min-h-7 items-center gap-3">
        <p className="num text-small text-fg-muted" aria-live="polite">
          {q.isSuccess ? t(needle ? "activity.countFiltered" : "activity.count", { count: rows.length, total: loaded.length }) : ""}
        </p>
        {filtered ? (
          <Button variant="ghost" size="sm" onClick={reset}>
            {t("activity.filter.reset")}
          </Button>
        ) : null}
      </div>
      {q.isPending ? (
        <DelayedSkeleton lines={6} />
      ) : q.isError ? (
        <ErrorView error={q.error} onRetry={() => void q.refetch()} />
      ) : rows.length === 0 && needle && q.hasNextPage ? (
        // The search only sees what is loaded; say so and offer the next page instead of "nothing found".
        <EmptyState
          className="rounded-md border border-border"
          icon={SearchX}
          title={t("activity.emptyLoaded")}
          action={
            <Button variant="secondary" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
              {t("activity.loadMoreToSearch")}
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          className="rounded-md border border-border"
          icon={filtered ? SearchX : History}
          title={filtered ? t("activity.emptyFiltered") : t("activity.empty")}
          action={
            filtered ? (
              <Button variant="secondary" onClick={reset}>
                {t("activity.filter.reset")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ActivityTimeline events={rows} label={t("activity.timelineLabel")} />
      )}
      <LoadMore hasNextPage={q.hasNextPage} isFetchingNextPage={q.isFetchingNextPage} fetchNextPage={q.fetchNextPage} />
    </>
  );
}
