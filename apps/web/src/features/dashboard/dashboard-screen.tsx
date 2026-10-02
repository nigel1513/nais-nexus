"use client";
import { Avatar, Badge, buttonClass, cn, DataTable, focusRing, type DataColumn } from "@nais/ui";
import type { InfiniteData } from "@tanstack/react-query";
import { ArrowRight, Cog } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useListAuditEvents } from "@/features/audit/api";
import { useSearchDatasets } from "@/features/catalog/api";
import { useListAccessGrants, useListAccessRequests } from "@/features/governance/api";
import { useOrgNames } from "@/features/organizations/api";
import { useListProjects } from "@/features/projects/api";
import { flattenPages } from "@/shared/api/pagination";
import type { AccessGrant, AccessRequest, AuditEvent, Page, Schemas } from "@/shared/api/types";
import { hasOrgRole, useMeData } from "@/shared/hooks/use-me";
import { AccessLevelBadge, ReadinessBadge } from "@/shared/ui/badges";
import { DateTime } from "@/shared/ui/date-text";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";

type Hit = Schemas["DatasetSearchHit"];
type ListQuery<T> = { data?: InfiniteData<Page<T>>; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };

const COUNT_LIMIT = 50;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const ZONE = "Asia/Seoul";
const INTRO_KEY = "nais.dashboard.intro";
const linkClass = "font-medium text-fg underline-offset-4 hover:underline";

/** "12", or "50+" when the first page was full (these lists have no totals). */
function countOf<T>(q: ListQuery<T>): string | null {
  if (!q.data) return null;
  const n = flattenPages(q.data).length;
  return q.data.pages.at(-1)?.page.has_more ? `${n}+` : String(n);
}

const dayKey = (iso: string | number) => new Intl.DateTimeFormat("ko-KR", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const timeOf = (iso: string) => new Intl.DateTimeFormat("ko-KR", { timeZone: ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
const todayLabel = () => new Intl.DateTimeFormat("ko-KR", { timeZone: ZONE, month: "long", day: "numeric", weekday: "long" }).format(new Date());
/** Whole days since `iso` (0 = today). */
const daysSince = (iso: string, now: number) => Math.max(0, Math.floor((now - Date.parse(iso)) / DAY_MS));

/**
 * The first visit of a browser session plays the short entrance (band → figures count up → blocks 40ms apart → bars
 * fill). Later visits render at rest: a screen opened many times a day must not replay a sequence. Storage can throw
 * (private mode, blocked site data); then it simply never animates.
 */
function useIntro(): boolean {
  const [intro, setIntro] = useState(false);
  useEffect(() => {
    try {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || sessionStorage.getItem(INTRO_KEY)) return;
      sessionStorage.setItem(INTRO_KEY, "1");
      setIntro(true);
    } catch {
      /* no storage: stay at rest */
    }
  }, []);
  return intro;
}

/** A figure that counts up from 0 once (600ms ease-out) when `animate`, otherwise shows its value. */
function CountUp({ value, animate }: { value: number; animate: boolean }) {
  const [shown, setShown] = useState(value);
  const done = useRef(false);
  useEffect(() => {
    if (!animate || done.current) return setShown(value);
    done.current = true;
    let raf = 0;
    const start = performance.now() + 120;
    const step = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / 600));
      setShown(Math.round((1 - (1 - t) ** 3) * value));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [animate, value]);
  return <>{shown}</>;
}

/** A dashboard block: kicker + heading + count on the left, "전체 보기" on the right, then its body. */
function Block({ kicker, title, count, moreHref, index, children }: { kicker: string; title: string; count?: string | null; moreHref?: string; index: number; children: ReactNode }) {
  const t = useTranslations();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="db-block flex min-w-0 flex-col gap-2.5" style={{ "--i": index } as CSSProperties}>
      <div className="flex min-h-7 items-baseline gap-2">
        <span className="db-kicker max-sm:hidden" aria-hidden="true">
          {kicker}
        </span>
        <h2 id={headingId} className="db-h2 flex min-w-0 items-baseline gap-2 break-keep">
          {title}
          {count ? <span className="num font-mono text-small font-normal text-fg-muted">{count}</span> : null}
        </h2>
        {moreHref ? (
          <Link href={moreHref} className={cn("ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm text-small text-fg-muted hover:text-fg", focusRing)}>
            {t("dashboard.viewAll")}
            <ArrowRight aria-hidden="true" strokeWidth={1.75} className="size-3.5" />
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  );
}

const panel = "overflow-hidden rounded-md border border-border bg-bg-panel";

/** Loading / error / empty around one block, so each block fails or empties on its own. Empty is one line, not a box. */
function QueryBody<T>({ query, children, empty }: { query: ListQuery<T>; children: (rows: T[]) => ReactNode; empty: ReactNode }) {
  if (query.isPending) return <DelayedSkeleton lines={3} />;
  if (query.isError) return <ErrorView error={query.error} onRetry={() => void query.refetch()} />;
  const rows = flattenPages(query.data);
  if (rows.length === 0) return <>{empty}</>;
  return <>{children(rows)}</>;
}

/** Empty block: one line and its next action. */
function Empty({ title, href, action }: { title: string; href: string; action: string }) {
  return (
    <div className={cn(panel, "flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 text-small text-fg-muted")}>
      <span>{title}</span>
      <Link href={href} className={buttonClass("secondary", "sm")}>
        {action}
      </Link>
    </div>
  );
}

function Stat({ href, label, value, unit, hint, warn, animate }: { href: string; label: string; value: number | null; unit: string; hint: string; warn?: boolean; animate: boolean }) {
  return (
    <li>
      <Link href={href} className={cn("db-stat", focusRing, "focus-visible:-outline-offset-2")} data-warn={warn ? "" : undefined}>
        <span className="db-stat-l">{label}</span>
        <span className="db-stat-v num">
          {value === null ? "—" : <CountUp value={value} animate={animate} />}
          {value === null ? null : <small>{unit}</small>}
        </span>
        <span className="db-stat-h">{hint}</span>
      </Link>
    </li>
  );
}

type ActivityRow = { event: AuditEvent; repeat: number };

/** Consecutive events with the same actor, action and result collapse into one row ("×6"), so system batches do not flood the list. */
function groupActivity(events: AuditEvent[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const e of events) {
    const last = rows.at(-1);
    const same = last && last.event.action === e.action && last.event.result === e.result && (last.event.actor.user_id ?? null) === (e.actor.user_id ?? null) && last.event.actor.type === e.actor.type;
    if (same) last.repeat += 1;
    else rows.push({ event: e, repeat: 1 });
  }
  return rows;
}

/** Recent activity grouped under 오늘 / 어제 / the date, each row with its time only. */
function ActivityList({ query }: { query: ListQuery<AuditEvent> }) {
  const t = useTranslations();
  return (
    <QueryBody query={query} empty={<Empty title={t("activity.empty")} href="/commons/activity" action={t("dashboard.openActivity")} />}>
      {(events) => {
        const now = Date.now();
        const today = dayKey(now);
        const yesterday = dayKey(now - DAY_MS);
        const rows = groupActivity(events).slice(0, 7);
        const days: Array<{ key: string; rows: ActivityRow[] }> = [];
        for (const r of rows) {
          const key = dayKey(r.event.occurred_at);
          if (days.at(-1)?.key === key) days.at(-1)!.rows.push(r);
          else days.push({ key, rows: [r] });
        }
        return (
          <div className={panel}>
            {days.map((d) => (
              <div key={d.key}>
                <h3 className="border-b border-border bg-bg-subtle px-4 py-1.5 text-caption text-fg-muted [div:not(:first-child)>&]:border-t">
                  {d.key === today ? t("dashboard.today") : d.key === yesterday ? t("dashboard.yesterday") : d.key}
                </h3>
                <ol aria-label={t("dashboard.activityList")}>
                  {d.rows.map(({ event: e, repeat }) => {
                    const system = e.actor.type === "SYSTEM" || !e.actor.display_name;
                    const actor = e.actor.display_name ?? t("activity.system");
                    return (
                      <li key={e.audit_event_id} className="grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-border px-4 py-2 last:border-b-0">
                        {system ? (
                          <span aria-hidden="true" className="flex size-5 items-center justify-center rounded-full bg-bg-active text-fg-muted">
                            <Cog strokeWidth={1.75} className="size-3" />
                          </span>
                        ) : (
                          <Avatar name={actor} size={20} decorative />
                        )}
                        <p className="min-w-0 truncate text-small text-fg">
                          <span className="font-semibold">{actor}</span> {t(`enums.AuditAction.${e.action}`)}
                          <span className="text-fg-muted"> · {t(`enums.ResourceType.${e.resource.type}`)}</span>
                          {repeat > 1 ? <span className="num ml-1.5 rounded-xs bg-bg-hover px-1 font-mono text-caption text-fg-muted">{t("dashboard.repeat", { count: repeat })}</span> : null}
                          {e.result === "DENIED" ? (
                            <Badge tone="danger" className="ml-1.5 align-middle">
                              {t("activity.result.DENIED")}
                            </Badge>
                          ) : null}
                        </p>
                        <time dateTime={e.occurred_at} className="num font-mono text-caption text-fg-muted">
                          {timeOf(e.occurred_at)}
                        </time>
                      </li>
                    );
                  })}
                </ol>
              </div>
            ))}
          </div>
        );
      }}
    </QueryBody>
  );
}

const STEP_STATE: Record<string, Array<"done" | "now" | undefined>> = {
  SUBMITTED: ["done", "now", undefined, undefined],
  UNDER_REVIEW: ["done", "now", undefined, undefined],
  CHANGE_REQUESTED: ["now", undefined, undefined, undefined],
};

/** The researcher's open requests, each with the start page's four steps (요청 · 검토 · 이용 · 종료). */
function MyRequests({ rows }: { rows: AccessRequest[] }) {
  const t = useTranslations();
  const orgNames = useOrgNames();
  return (
    <ul className={panel}>
      {rows.slice(0, 6).map((r) => {
        const change = r.status === "CHANGE_REQUESTED";
        const states = STEP_STATE[r.status] ?? STEP_STATE.SUBMITTED!;
        return (
          <li key={r.access_request_id} className="grid grid-cols-1 items-center gap-x-5 gap-y-2 border-b border-border px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1.4fr)_auto]">
            <div className="min-w-0">
              <Link href={`/commons/access/${r.access_request_id}`} className={cn(linkClass, "block truncate")}>
                {r.dataset_title ?? r.dataset_id}
              </Link>
              <p className="truncate text-caption text-fg-muted">
                {orgNames[r.owner_organization_id] ?? ""} · {t(`enums.Purpose.${r.purpose}`)} · {t("dashboard.days", { count: r.requested_days })}
              </p>
            </div>
            <ol className="db-steps" aria-label={t("dashboard.steps.label")}>
              {(["request", "review", "use", "end"] as const).map((k, i) => (
                <li key={k} data-state={states[i]} aria-current={states[i] === "now" ? "step" : undefined}>
                  {t(`dashboard.steps.${k}`)}
                </li>
              ))}
            </ol>
            {change ? (
              <Link href={`/commons/access/${r.access_request_id}`} className={cn(buttonClass("primary", "sm"), "justify-self-start sm:justify-self-end")}>
                {t("dashboard.fix")}
              </Link>
            ) : (
              <span className="justify-self-start text-caption text-fg-muted sm:justify-self-end">{t(`enums.AccessRequestStatus.${r.status}`)}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Grants in the order they end: D-day and the share of the grant period that is left (amber within 7 days). */
function GrantList({ rows }: { rows: AccessGrant[] }) {
  const t = useTranslations();
  const now = Date.now();
  const sorted = [...rows].sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at)).slice(0, 5);
  return (
    <ul className={panel}>
      {sorted.map((g) => {
        const end = Date.parse(g.expires_at);
        const start = Date.parse(g.valid_from);
        const left = Math.max(0, end - now);
        const days = Math.ceil(left / DAY_MS);
        const share = end > start ? Math.min(1, left / (end - start)) : 0;
        const warn = left <= WEEK_MS;
        return (
          <li key={g.access_grant_id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-3 last:border-b-0">
            <div className="min-w-0">
              <Link href={`/commons/data/${g.dataset_id}`} className={cn(linkClass, "block truncate")}>
                {g.dataset_title ?? g.dataset_id}
              </Link>
              <p className="truncate text-caption text-fg-muted">{t("dashboard.grantScope", { project: g.project_name ?? "—", purpose: t(`enums.Purpose.${g.purpose}`) })}</p>
            </div>
            <span className={cn("num font-mono text-small font-semibold", warn ? "text-warning" : "text-fg")} title={new Date(g.expires_at).toISOString()}>
              {days === 0 ? t("dashboard.ddayToday") : t("dashboard.dday", { days })}
            </span>
            <span className="db-track col-span-2" aria-hidden="true">
              <i data-warn={warn ? "" : undefined} style={{ width: `${Math.max(2, share * 100)}%` }} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Readiness share bar and access-level counts over the institute's latest datasets (computed from the rows shown). */
function DatasetSummary({ rows }: { rows: Hit[] }) {
  const t = useTranslations();
  const n = (v: Hit["readiness_overall"]) => rows.filter((d) => (d.readiness_overall ?? null) === v).length;
  const parts = [
    { key: "pass", count: n("PASS"), color: "var(--color-success-solid)" },
    { key: "warn", count: n("WARNING"), color: "var(--color-warning-solid)" },
    { key: "fail", count: n("FAIL"), color: "var(--color-danger-solid)" },
    { key: "none", count: n(null), color: "var(--color-chart-muted)" },
  ];
  const levels = Object.entries(
    rows.reduce<Record<string, number>>((acc, d) => ({ ...acc, [d.access_level]: (acc[d.access_level] ?? 0) + 1 }), {}),
  );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3 text-small text-fg-muted">
      <span className="font-medium text-fg">{t("dashboard.readinessSummary")}</span>
      <span className="db-seg" aria-hidden="true">
        {parts.filter((p) => p.count > 0).map((p) => (
          <i key={p.key} style={{ flex: p.count, background: p.color }} />
        ))}
      </span>
      <span className="num">{t("dashboard.readinessCounts", { pass: parts[0]!.count, warn: parts[1]!.count, fail: parts[2]!.count, none: parts[3]!.count })}</span>
      <span className="num sm:ml-auto">{levels.map(([level, count]) => `${t(`enums.AccessLevel.${level}`)} ${count}`).join(" · ")}</span>
    </div>
  );
}

/**
 * Dashboard (storyboard https://claude.ai/artifact/2bt58HP5pKjKXxhrKNAWoJ): a summary band that states today's work in
 * one line with four linked figures, then what to act on (review queue / my requests with steps) beside grants in the
 * order they end, the institute's datasets with a readiness share, and projects beside day-grouped activity. A first
 * visitor gets a start sequence instead of empty boxes. Data loading is unchanged: the same seven queries, each block
 * loading and failing on its own.
 */
export function DashboardScreen() {
  const t = useTranslations();
  const me = useMeData();
  const steward = hasOrgRole(me, "DATA_STEWARD");
  const projects = useListProjects({ scope: "mine", limit: COUNT_LIMIT });
  const myRequests = useListAccessRequests({ role: "requester", status: ["SUBMITTED", "UNDER_REVIEW", "CHANGE_REQUESTED"], limit: COUNT_LIMIT });
  const grants = useListAccessGrants({ role: "subject", status: ["ACTIVE"], limit: COUNT_LIMIT });
  const review = useListAccessRequests({ role: "reviewer", status: ["SUBMITTED", "UNDER_REVIEW"], limit: COUNT_LIMIT }, { enabled: steward });
  const activity = useListAuditEvents({ limit: 30 });
  const datasetsQuery = useSearchDatasets({ owner_organization_id: [me.organization.organization_id], sort: "updated_desc", limit: 5 });
  const datasets = datasetsQuery as unknown as ListQuery<Hit>;
  const orgNames = useOrgNames();
  const intro = useIntro();

  const grantRows = useMemo(() => flattenPages(grants.data), [grants.data]);
  const requestRows = useMemo(() => flattenPages(myRequests.data), [myRequests.data]);
  const reviewRows = useMemo(() => flattenPages(review.data), [review.data]);
  const now = Date.now();
  const expiring = grantRows.filter((g) => Date.parse(g.expires_at) - now <= WEEK_MS).length;
  const queue = steward ? review : myRequests;
  const queueCount = countOf(queue);
  const queueHref = steward ? "/commons/access?tab=review" : "/commons/access?tab=requests";
  const orgDatasets = t("dashboard.orgDatasets", { org: me.organization.name });
  const projectRows = useMemo(() => flattenPages(projects.data), [projects.data]);
  // Nothing in progress yet (all three lists loaded and empty): show the start sequence instead of empty boxes.
  const fresh = !steward && !!projects.data && !!myRequests.data && !!grants.data && projectRows.length === 0 && requestRows.length === 0 && grantRows.length === 0;
  const roleLabel = steward ? t("enums.OrgRole.DATA_STEWARD") : hasOrgRole(me, "ORG_ADMIN") ? t("enums.OrgRole.ORG_ADMIN") : t("dashboard.researcher");
  const num = (q: { data?: unknown }, n: number) => (q.data ? n : null);
  const oldest = reviewRows.length ? Math.max(...reviewRows.map((r) => daysSince(r.created_at, now))) : null;
  const changeRequested = requestRows.filter((r) => r.status === "CHANGE_REQUESTED").length;
  const unitCount = t("dashboard.unit.count");
  const unitItems = t("dashboard.unit.items");

  const clear = steward && !!review.data && !!grants.data && reviewRows.length === 0 && expiring === 0;
  const headline = fresh
    ? t("dashboard.headlineFresh")
    : clear
      ? t("dashboard.headlineClear")
    : t.rich(steward ? "dashboard.headlineSteward" : "dashboard.headlineResearcher", {
        em: (chunks) => <em>{chunks}</em>,
        review: queueCount ?? "—",
        expiring: grants.data ? expiring : "—",
        requests: countOf(myRequests) ?? "—",
        grants: countOf(grants) ?? "—",
      });

  const reviewColumns: DataColumn<AccessRequest>[] = [
    {
      key: "requester",
      header: t("dashboard.columns.requester"),
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar name={r.requester_display_name ?? "?"} size={24} decorative />
          <span className="min-w-0">
            <span className="block truncate font-medium">{t("dashboard.requestedBy", { name: r.requester_display_name ?? "—" })}</span>
            <span className="block truncate text-caption text-fg-muted">{orgNames[r.requester_organization_id] ?? ""}</span>
          </span>
        </span>
      ),
    },
    {
      key: "dataset",
      header: t("dashboard.columns.dataset"),
      cell: (r) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium">{r.dataset_title ?? r.dataset_id}</span>
          <span className="block truncate text-caption text-fg-muted">
            {t(`enums.Purpose.${r.purpose}`)} · {t("dashboard.days", { count: r.requested_days })}
          </span>
        </span>
      ),
    },
    {
      key: "waiting",
      header: t("dashboard.columns.submitted"),
      cell: (r) => {
        const d = daysSince(r.created_at, now);
        return <span className={cn("num font-mono text-small", d > 0 ? "font-semibold text-warning" : "text-fg-muted")}>{d > 0 ? t("dashboard.waitDays", { days: d }) : t("dashboard.waitToday")}</span>;
      },
    },
    {
      key: "go",
      header: "",
      cell: (r) => (
        <Link href={`/commons/access/${r.access_request_id}`} className={buttonClass("primary", "sm")} aria-label={`${t("dashboard.review")}: ${r.dataset_title ?? r.dataset_id}`}>
          {t("dashboard.review")}
        </Link>
      ),
    },
  ];

  const datasetColumns: DataColumn<Hit>[] = [
    {
      key: "title",
      header: t("dashboard.columns.dataset"),
      cell: (d) => (
        <Link href={`/commons/data/${d.dataset_id}`} className={linkClass}>
          {d.title}
        </Link>
      ),
    },
    { key: "version", header: t("dashboard.columns.version"), cell: (d) => <span className="font-mono text-mono">{d.latest_version_label ?? "—"}</span> },
    { key: "access", header: t("dashboard.columns.access"), cell: (d) => <AccessLevelBadge level={d.access_level} /> },
    { key: "ready", header: t("dashboard.columns.readiness"), cell: (d) => <ReadinessBadge value={d.readiness_overall} /> },
    { key: "updated", header: t("dashboard.columns.updated"), numeric: true, cell: (d) => (d.updated_at ? <DateTime value={d.updated_at} dateOnly /> : "—") },
  ];

  const stats = steward
    ? [
        { href: queueHref, label: t("dashboard.s.review"), value: num(review, reviewRows.length), unit: unitCount, hint: oldest === null || reviewRows.length === 0 ? t("dashboard.s.reviewNone") : oldest > 0 ? t("dashboard.s.reviewOldest", { days: oldest }) : t("dashboard.s.reviewToday") },
        { href: "/commons/access?tab=requests", label: t("dashboard.s.requests"), value: num(myRequests, requestRows.length), unit: unitCount, hint: changeRequested ? t("dashboard.s.requestsChange", { count: changeRequested }) : requestRows.length ? t("dashboard.s.requestsWaiting") : t("dashboard.s.requestsNone") },
        { href: "/commons/access?tab=grants", label: t("dashboard.s.grants"), value: num(grants, grantRows.length), unit: unitItems, hint: t("dashboard.s.grantsHint") },
        { href: "/commons/access?tab=grants", label: t("dashboard.s.expiring"), value: num(grants, expiring), unit: unitItems, hint: expiring ? t("dashboard.s.expiringHint") : t("dashboard.s.expiringNone"), warn: expiring > 0 },
      ]
    : [
        { href: queueHref, label: t("dashboard.s.requests"), value: num(myRequests, requestRows.length), unit: unitCount, hint: changeRequested ? t("dashboard.s.requestsChange", { count: changeRequested }) : requestRows.length ? t("dashboard.s.requestsWaiting") : t("dashboard.s.requestsNone") },
        { href: "/commons/access?tab=grants", label: t("dashboard.s.grants"), value: num(grants, grantRows.length), unit: unitItems, hint: t("dashboard.s.grantsHint") },
        { href: "/commons/access?tab=grants", label: t("dashboard.s.expiring"), value: num(grants, expiring), unit: unitItems, hint: expiring ? t("dashboard.s.expiringHint") : t("dashboard.s.expiringNone"), warn: expiring > 0 },
        { href: "/commons/projects", label: t("dashboard.s.projects"), value: num(projects, projectRows.length), unit: unitItems, hint: t("dashboard.s.projectsHint") },
      ];

  const primary = steward && reviewRows.length > 0 ? { href: queueHref, label: t("dashboard.goReview") } : { href: "/commons/data", label: t("dashboard.findData") };
  const secondary = steward ? { href: "/commons/data/new", label: t("dashboard.newDataset") } : { href: "/commons/projects/new", label: t("dashboard.newProject") };

  return (
    <div className="flex flex-col gap-8" data-intro={intro ? "" : undefined}>
      <section className="db-band break-keep" aria-labelledby="db-title" data-fresh={fresh ? "" : undefined}>
        <div className="db-band-in">
          <div className="min-w-0">
            <div className="db-ctx">
              <h1 id="db-title">{t("dashboard.title")}</h1>
              <span aria-hidden="true">·</span>
              <span>{me.organization.name}</span>
              <span className="db-role">{roleLabel}</span>
              <span aria-hidden="true">·</span>
              <span suppressHydrationWarning>{todayLabel()}</span>
            </div>
            <p className="db-headline">{headline}</p>
            {fresh ? <p className="db-fresh">{t("dashboard.freshBody")}</p> : null}
          </div>
          <div className="db-acts">
            <Link href={primary.href} className={cn("db-hb db-hb-w", focusRing)}>
              {primary.label}
              <ArrowRight aria-hidden="true" strokeWidth={1.75} className="size-4" />
            </Link>
            <Link href={secondary.href} className={cn("db-hb db-hb-g", focusRing)}>
              {secondary.label}
            </Link>
          </div>
        </div>
        {fresh ? null : (
          <ul className="db-stats" aria-label={t("dashboard.summary")}>
            {stats.map((s) => (
              <Stat key={s.label} {...s} animate={intro} />
            ))}
          </ul>
        )}
      </section>

      {fresh ? (
        <section aria-labelledby="db-start" className="db-block flex flex-col gap-2.5" style={{ "--i": 0 } as CSSProperties}>
          <div className="flex items-baseline gap-2">
            <span className="db-kicker" aria-hidden="true">
              {t("dashboard.kicker.start")}
            </span>
            <h2 id="db-start" className="db-h2">
              {t("dashboard.start.title")}
            </h2>
          </div>
          <ol className={cn(panel, "grid grid-cols-1 md:grid-cols-3")}>
            {(
              [
                ["find", "/commons/data", t("dashboard.findData"), true],
                ["request", null, null, false],
                ["project", "/commons/projects/new", t("dashboard.newProject"), false],
              ] as const
            ).map(([k, href, action, main], i) => (
              <li key={k} className="flex flex-col gap-1.5 border-border p-4 max-md:border-t max-md:first:border-t-0 md:border-l md:first:border-l-0">
                <span className="num font-mono text-caption text-accent-fg">{i + 1}</span>
                <b className="text-heading text-fg">{t(`dashboard.start.${k}`)}</b>
                <p className="text-small text-fg-muted">{t(`dashboard.start.${k}Body`)}</p>
                {href && action ? (
                  <Link href={href} className={cn(buttonClass(main ? "primary" : "secondary", "sm"), "mt-1 self-start")}>
                    {action}
                  </Link>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <Block kicker={t("dashboard.kicker.todo")} title={t(steward ? "dashboard.reviewQueue" : "dashboard.openRequests")} count={queueCount} moreHref={queueHref} index={1}>
          <QueryBody
            query={queue}
            empty={
              steward ? (
                <Empty title={t("dashboard.noReview")} href="/commons/access?tab=review" action={t("dashboard.openAccess")} />
              ) : (
                <Empty title={t("dashboard.noRequests")} href="/commons/data" action={t("dashboard.findData")} />
              )
            }
          >
            {(rows) =>
              steward ? (
                <DataTable
                  caption={t("dashboard.reviewQueue")}
                  columns={reviewColumns}
                  rows={[...rows].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)).slice(0, 6)}
                  rowKey={(r) => r.access_request_id}
                />
              ) : (
                <MyRequests rows={rows} />
              )
            }
          </QueryBody>
        </Block>
        <Block kicker={t("dashboard.kicker.grants")} title={t("dashboard.myGrants")} count={countOf(grants)} moreHref="/commons/access?tab=grants" index={2}>
          <QueryBody query={grants} empty={<Empty title={t("dashboard.noGrants")} href="/commons/data" action={t("dashboard.findData")} />}>
            {(rows) => <GrantList rows={rows} />}
          </QueryBody>
        </Block>
      </div>

      <Block kicker={t("dashboard.kicker.org")} title={orgDatasets} moreHref="/commons/data" index={3}>
        <QueryBody
          query={datasets}
          empty={
            steward ? (
              <Empty title={t("dashboard.noDatasets")} href="/commons/data/new" action={t("dashboard.newDataset")} />
            ) : (
              <Empty title={t("dashboard.noDatasets")} href="/commons/data" action={t("dashboard.findData")} />
            )
          }
        >
          {(rows) => (
            <div className={panel}>
              <DatasetSummary rows={rows} />
              <div className="[&_.rounded-md.border]:rounded-none [&_.rounded-md.border]:border-0">
                <DataTable caption={orgDatasets} columns={datasetColumns} rows={rows} rowKey={(d) => d.dataset_id} />
              </div>
            </div>
          )}
        </QueryBody>
      </Block>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <Block kicker={t("dashboard.kicker.projects")} title={t("dashboard.myProjects")} count={countOf(projects)} moreHref="/commons/projects" index={4}>
          <QueryBody query={projects} empty={<Empty title={t("dashboard.noProjects")} href="/commons/projects/new" action={t("dashboard.createFirstProject")} />}>
            {(rows) => (
              <ul className={panel}>
                {rows.slice(0, 5).map((p) => (
                  <li key={p.project_id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
                    <div className="min-w-0">
                      <Link href={`/commons/projects/${p.project_id}`} className={cn(linkClass, "block truncate")}>
                        {p.name}
                      </Link>
                      <p className="truncate text-caption text-fg-muted">
                        {t("dashboard.projectMeta", { org: p.lead_organization_name ?? orgNames[p.lead_organization_id] ?? "—", count: p.member_count ?? "—" })}
                      </p>
                    </div>
                    {p.my_role ? <Badge tone={p.my_role === "PROJECT_OWNER" ? "accent" : "neutral"}>{t(`enums.ProjectRole.${p.my_role}`)}</Badge> : null}
                  </li>
                ))}
              </ul>
            )}
          </QueryBody>
        </Block>
        <Block kicker={t("dashboard.kicker.activity")} title={t("dashboard.recentActivity")} moreHref="/commons/activity" index={5}>
          <ActivityList query={activity} />
        </Block>
      </div>
    </div>
  );
}
