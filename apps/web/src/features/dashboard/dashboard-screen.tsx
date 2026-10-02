"use client";
import { Avatar, Badge, buttonClass, cn, DataTable, focusRing, type DataColumn } from "@nais/ui";
import type { InfiniteData } from "@tanstack/react-query";
import { ArrowRight, Cog } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useMemo, type ReactNode } from "react";
import { useListAuditEvents } from "@/features/audit/api";
import { useSearchDatasets } from "@/features/catalog/api";
import { useListAccessGrants, useListAccessRequests } from "@/features/governance/api";
import { useOrgNames } from "@/features/organizations/api";
import { useListProjects } from "@/features/projects/api";
import { flattenPages } from "@/shared/api/pagination";
import type { AccessGrant, AccessRequest, AuditEvent, Page, ProjectSummary, Schemas } from "@/shared/api/types";
import { hasOrgRole, useMeData } from "@/shared/hooks/use-me";
import { AccessLevelBadge, ReadinessBadge, RequestStatusBadge } from "@/shared/ui/badges";
import { DateTime } from "@/shared/ui/date-text";
import { PageHeader } from "@/shared/ui/page-header";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";

type Hit = Schemas["DatasetSearchHit"];
type ListQuery<T> = { data?: InfiniteData<Page<T>>; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };

const COUNT_LIMIT = 50;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const ZONE = "Asia/Seoul";
const linkClass = "font-medium text-fg underline-offset-4 hover:underline";
const panel = "overflow-hidden rounded-md border border-border bg-bg-panel";

/** "12", or "50+" when the first page was full (these lists have no totals). */
function countOf<T>(q: ListQuery<T>): string | null {
  if (!q.data) return null;
  const n = flattenPages(q.data).length;
  return q.data.pages.at(-1)?.page.has_more ? `${n}+` : String(n);
}

const dayKey = (v: string | number) => new Intl.DateTimeFormat("ko-KR", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(v));
const timeOf = (iso: string) => new Intl.DateTimeFormat("ko-KR", { timeZone: ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
const shortDate = (iso: string) => new Intl.DateTimeFormat("ko-KR", { timeZone: ZONE, month: "numeric", day: "numeric" }).format(new Date(iso));
const daysSince = (iso: string, now: number) => Math.max(0, Math.floor((now - Date.parse(iso)) / DAY_MS));

/** A block: heading + count, "전체 보기" on the right, then its table or list. */
function Block({ title, count, moreHref, children }: { title: string; count?: string | null; moreHref?: string; children: ReactNode }) {
  const t = useTranslations();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2.5">
      <div className="flex h-7 items-center justify-between gap-3">
        <h2 id={headingId} className="flex min-w-0 items-baseline gap-2 text-heading text-fg">
          <span className="truncate">{title}</span>
          {count ? <span className="num text-small font-normal text-fg-muted">{count}</span> : null}
        </h2>
        {moreHref ? (
          <Link href={moreHref} className={cn("flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm text-small text-fg-muted hover:text-fg", focusRing)}>
            {t("dashboard.viewAll")}
            <ArrowRight aria-hidden="true" strokeWidth={1.75} className="size-3.5" />
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/** Loading / error / empty around one block, so each block fails or empties on its own. */
function QueryBody<T>({ query, children, empty }: { query: ListQuery<T>; children: (rows: T[]) => ReactNode; empty: ReactNode }) {
  if (query.isPending) return <DelayedSkeleton lines={3} />;
  if (query.isError) return <ErrorView error={query.error} onRetry={() => void query.refetch()} />;
  const rows = flattenPages(query.data);
  if (rows.length === 0) return <>{empty}</>;
  return <>{children(rows)}</>;
}

/** Empty block: one muted line and the next step as a link. */
function Empty({ title, href, action }: { title: string; href: string; action: string }) {
  return (
    <div className={cn(panel, "flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 text-small")}>
      <span className="text-fg-muted">{title}</span>
      <Link href={href} className={cn("flex items-center gap-1 rounded-sm font-medium text-fg hover:underline", focusRing)}>
        {action}
        <ArrowRight aria-hidden="true" strokeWidth={1.75} className="size-3.5" />
      </Link>
    </div>
  );
}

function StatCard({ href, label, value, hint, warn }: { href: string; label: string; value: string | null; hint: string; warn?: boolean }) {
  return (
    <li className="flex">
      <Link
        href={href}
        className={cn("flex min-w-0 flex-1 flex-col gap-1 rounded-md border border-border bg-bg-panel px-4 py-3.5 transition-colors hover:border-border-strong hover:bg-bg-subtle", focusRing)}
      >
        <span className="text-small text-fg-muted">{label}</span>
        <span className={cn("num text-display", warn ? "text-warning" : "text-fg")}>{value ?? "—"}</span>
        <span className="truncate text-caption font-normal text-fg-muted">{hint}</span>
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

function ActivityList({ query }: { query: ListQuery<AuditEvent> }) {
  const t = useTranslations();
  return (
    <QueryBody query={query} empty={<Empty title={t("activity.empty")} href="/commons/activity" action={t("dashboard.openActivity")} />}>
      {(events) => {
        const today = dayKey(Date.now());
        return (
          <ol aria-label={t("dashboard.activityList")} className={panel}>
            {groupActivity(events)
              .slice(0, 8)
              .map(({ event: e, repeat }) => {
                const system = e.actor.type === "SYSTEM" || !e.actor.display_name;
                const actor = e.actor.display_name ?? t("activity.system");
                const when = dayKey(e.occurred_at) === today ? timeOf(e.occurred_at) : shortDate(e.occurred_at);
                return (
                  <li key={e.audit_event_id} className="flex items-start gap-2.5 border-b border-border px-3.5 py-2.5 last:border-b-0">
                    {system ? (
                      <span aria-hidden="true" className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-bg-active text-fg-muted">
                        <Cog strokeWidth={1.75} className="size-3" />
                      </span>
                    ) : (
                      <Avatar name={actor} size={20} decorative className="mt-0.5" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-small text-fg">
                        <span className="font-medium">{actor}</span> {t(`enums.AuditAction.${e.action}`)}
                        {repeat > 1 ? <span className="num ml-1 text-fg-muted">{t("dashboard.repeat", { count: repeat })}</span> : null}
                        {e.result === "DENIED" ? (
                          <Badge tone="danger" className="ml-1.5 align-middle">
                            {t("activity.result.DENIED")}
                          </Badge>
                        ) : null}
                      </p>
                      <p className="text-caption font-normal text-fg-muted">{t(`enums.ResourceType.${e.resource.type}`)}</p>
                    </div>
                    <time dateTime={e.occurred_at} className="num shrink-0 font-mono text-caption font-normal text-fg-muted">
                      {when}
                    </time>
                  </li>
                );
              })}
          </ol>
        );
      }}
    </QueryBody>
  );
}

/** Active grants in the order they end, with days left (amber within 7 days). */
function GrantList({ rows }: { rows: AccessGrant[] }) {
  const t = useTranslations();
  const now = Date.now();
  return (
    <ul className={panel}>
      {[...rows]
        .sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at))
        .slice(0, 5)
        .map((g) => {
          const left = Date.parse(g.expires_at) - now;
          const days = Math.max(0, Math.ceil(left / DAY_MS));
          const warn = left <= WEEK_MS;
          return (
            <li key={g.access_grant_id} className="flex items-center gap-3 border-b border-border px-3.5 py-2.5 last:border-b-0">
              <div className="min-w-0 flex-1">
                <Link href={`/commons/data/${g.dataset_id}`} className={cn(linkClass, "block truncate text-small")}>
                  {g.dataset_title ?? g.dataset_id}
                </Link>
                <p className="truncate text-caption font-normal text-fg-muted">
                  {g.project_name ?? "—"} · <DateTime value={g.expires_at} dateOnly />
                </p>
              </div>
              <span className={cn("num shrink-0 font-mono text-small", warn ? "font-semibold text-warning" : "text-fg-muted")}>
                {days === 0 ? t("dashboard.ddayToday") : t("dashboard.dday", { days })}
              </span>
            </li>
          );
        })}
    </ul>
  );
}

/**
 * Dashboard: a plain work screen. Header with the institute and role, four linked figures, then tables on the left
 * (what to act on, the institute's datasets, projects) and short lists on the right (grants by expiry, activity).
 * Data loading is unchanged from Task 12: the same seven queries, each block loading and failing on its own.
 */
export function DashboardScreen() {
  const t = useTranslations();
  const me = useMeData();
  const orgNames = useOrgNames();
  const steward = hasOrgRole(me, "DATA_STEWARD");
  const projects = useListProjects({ scope: "mine", limit: COUNT_LIMIT });
  const myRequests = useListAccessRequests({ role: "requester", status: ["SUBMITTED", "UNDER_REVIEW", "CHANGE_REQUESTED"], limit: COUNT_LIMIT });
  const grants = useListAccessGrants({ role: "subject", status: ["ACTIVE"], limit: COUNT_LIMIT });
  const review = useListAccessRequests({ role: "reviewer", status: ["SUBMITTED", "UNDER_REVIEW"], limit: COUNT_LIMIT }, { enabled: steward });
  const activity = useListAuditEvents({ limit: 30 });
  const datasetsQuery = useSearchDatasets({ owner_organization_id: [me.organization.organization_id], sort: "updated_desc", limit: 5 });
  const datasets = datasetsQuery as unknown as ListQuery<Hit>;

  const grantRows = useMemo(() => flattenPages(grants.data), [grants.data]);
  const requestRows = useMemo(() => flattenPages(myRequests.data), [myRequests.data]);
  const reviewRows = useMemo(() => flattenPages(review.data), [review.data]);
  const now = Date.now();
  const expiring = grantRows.filter((g) => Date.parse(g.expires_at) - now <= WEEK_MS).length;
  const queue = steward ? review : myRequests;
  const queueHref = steward ? "/commons/access?tab=review" : "/commons/access?tab=requests";
  const orgDatasets = t("dashboard.orgDatasets", { org: me.organization.name });
  const role = steward ? t("enums.OrgRole.DATA_STEWARD") : hasOrgRole(me, "ORG_ADMIN") ? t("enums.OrgRole.ORG_ADMIN") : t("dashboard.researcher");
  const oldest = reviewRows.length ? Math.max(...reviewRows.map((r) => daysSince(r.created_at, now))) : 0;
  const changeRequested = requestRows.filter((r) => r.status === "CHANGE_REQUESTED").length;

  const stats = [
    steward
      ? { href: queueHref, label: t("dashboard.s.review"), value: countOf(review), hint: reviewRows.length ? (oldest > 0 ? t("dashboard.s.reviewOldest", { days: oldest }) : t("dashboard.s.reviewToday")) : t("dashboard.s.reviewNone") }
      : { href: "/commons/projects", label: t("dashboard.s.projects"), value: countOf(projects), hint: t("dashboard.s.projectsHint") },
    { href: "/commons/access?tab=requests", label: t("dashboard.s.requests"), value: countOf(myRequests), hint: changeRequested ? t("dashboard.s.requestsChange", { count: changeRequested }) : t("dashboard.s.requestsHint") },
    { href: "/commons/access?tab=grants", label: t("dashboard.s.grants"), value: countOf(grants), hint: t("dashboard.s.grantsHint") },
    { href: "/commons/access?tab=grants", label: t("dashboard.s.expiring"), value: grants.data ? String(expiring) : null, hint: t("dashboard.s.expiringHint"), warn: expiring > 0 },
  ];

  const reviewColumns: DataColumn<AccessRequest>[] = [
    {
      key: "dataset",
      header: t("dashboard.columns.dataset"),
      cell: (r) => (
        <Link href={`/commons/access/${r.access_request_id}`} className={linkClass}>
          {r.dataset_title ?? r.dataset_id}
        </Link>
      ),
    },
    {
      key: "requester",
      header: t("dashboard.columns.requester"),
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2">
          <Avatar name={r.requester_display_name ?? "?"} size={20} decorative />
          <span className="truncate">{t("dashboard.requestedBy", { name: r.requester_display_name ?? "—" })}</span>
          <span className="truncate text-fg-muted">{orgNames[r.requester_organization_id] ?? ""}</span>
        </span>
      ),
    },
    { key: "purpose", header: t("dashboard.columns.purpose"), cell: (r) => t(`enums.Purpose.${r.purpose}`) },
    { key: "days", header: t("dashboard.columns.days"), numeric: true, cell: (r) => t("dashboard.days", { count: r.requested_days }) },
    {
      key: "waiting",
      header: t("dashboard.columns.waiting"),
      numeric: true,
      cell: (r) => {
        const d = daysSince(r.created_at, now);
        return <span className={d > 0 ? "font-medium text-warning" : "text-fg-muted"}>{d > 0 ? t("dashboard.waitDays", { days: d }) : t("dashboard.waitToday")}</span>;
      },
    },
  ];

  const requestColumns: DataColumn<AccessRequest>[] = [
    {
      key: "dataset",
      header: t("dashboard.columns.dataset"),
      cell: (r) => (
        <Link href={`/commons/access/${r.access_request_id}`} className={linkClass}>
          {r.dataset_title ?? r.dataset_id}
        </Link>
      ),
    },
    { key: "owner", header: t("dashboard.columns.owner"), cell: (r) => <span className="text-fg-muted">{orgNames[r.owner_organization_id] ?? "—"}</span> },
    { key: "project", header: t("dashboard.columns.project"), cell: (r) => <span className="text-fg-muted">{r.project_name ?? "—"}</span> },
    { key: "status", header: t("dashboard.columns.status"), cell: (r) => <RequestStatusBadge status={r.status} /> },
    { key: "created", header: t("dashboard.columns.submitted"), numeric: true, cell: (r) => <DateTime value={r.created_at} dateOnly /> },
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

  const projectColumns: DataColumn<ProjectSummary>[] = [
    {
      key: "name",
      header: t("dashboard.columns.project"),
      cell: (p) => (
        <Link href={`/commons/projects/${p.project_id}`} className={linkClass}>
          {p.name}
        </Link>
      ),
    },
    { key: "lead", header: t("dashboard.columns.lead"), cell: (p) => <span className="text-fg-muted">{p.lead_organization_name ?? orgNames[p.lead_organization_id] ?? "—"}</span> },
    { key: "role", header: t("dashboard.columns.myRole"), cell: (p) => (p.my_role ? t(`enums.ProjectRole.${p.my_role}`) : "—") },
    { key: "members", header: t("dashboard.columns.members"), numeric: true, cell: (p) => p.member_count ?? "—" },
    { key: "updated", header: t("dashboard.columns.updated"), numeric: true, cell: (p) => (p.updated_at ? <DateTime value={p.updated_at} dateOnly /> : "—") },
  ];

  return (
    <>
      <PageHeader
        title={t("dashboard.title")}
        description={`${me.organization.name} · ${role}`}
        actions={
          <>
            <Link href="/commons/data" className={buttonClass("secondary", "md")}>
              {t("dashboard.findData")}
            </Link>
            {steward ? (
              <Link href="/commons/data/new" className={buttonClass("primary", "md")}>
                {t("dashboard.newDataset")}
              </Link>
            ) : (
              <Link href="/commons/projects/new" className={buttonClass("primary", "md")}>
                {t("dashboard.newProject")}
              </Link>
            )}
          </>
        }
      />
      <div className="flex flex-col gap-8">
        <ul aria-label={t("dashboard.summary")} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {stats.map((s) => (
            <StatCard key={s.label} {...s} />
          ))}
        </ul>

        <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="flex min-w-0 flex-col gap-8">
            <Block title={t(steward ? "dashboard.reviewQueue" : "dashboard.openRequests")} count={countOf(queue)} moreHref={queueHref}>
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
                {(rows) => (
                  <DataTable
                    caption={t(steward ? "dashboard.reviewQueue" : "dashboard.openRequests")}
                    columns={steward ? reviewColumns : requestColumns}
                    rows={[...rows].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)).slice(0, 6)}
                    rowKey={(r) => r.access_request_id}
                  />
                )}
              </QueryBody>
            </Block>

            <Block title={orgDatasets} moreHref="/commons/data">
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
                {(rows) => <DataTable caption={orgDatasets} columns={datasetColumns} rows={rows} rowKey={(d) => d.dataset_id} />}
              </QueryBody>
            </Block>

            <Block title={t("dashboard.myProjects")} count={countOf(projects)} moreHref="/commons/projects">
              <QueryBody query={projects} empty={<Empty title={t("dashboard.noProjects")} href="/commons/projects/new" action={t("dashboard.createFirstProject")} />}>
                {(rows) => <DataTable caption={t("dashboard.myProjects")} columns={projectColumns} rows={rows.slice(0, 5)} rowKey={(p) => p.project_id} />}
              </QueryBody>
            </Block>
          </div>

          <div className="flex min-w-0 flex-col gap-8">
            <Block title={t("dashboard.myGrants")} count={countOf(grants)} moreHref="/commons/access?tab=grants">
              <QueryBody query={grants} empty={<Empty title={t("dashboard.noGrants")} href="/commons/data" action={t("dashboard.findData")} />}>
                {(rows) => <GrantList rows={rows} />}
              </QueryBody>
            </Block>
            <Block title={t("dashboard.recentActivity")} moreHref="/commons/activity">
              <ActivityList query={activity} />
            </Block>
          </div>
        </div>
      </div>
    </>
  );
}
