"use client";
import { Avatar, Badge, buttonClass, cn, DataTable, EmptyState, focusRing, type DataColumn } from "@nais/ui";
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
import { DateTime, ExpiryText } from "@/shared/ui/date-text";
import { PageHeader } from "@/shared/ui/page-header";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";

type Hit = Schemas["DatasetSearchHit"];
type ListQuery<T> = { data?: InfiniteData<Page<T>>; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };

const COUNT_LIMIT = 50;
const WEEK_MS = 7 * 86_400_000;
const linkClass = "font-medium text-fg underline-offset-4 hover:underline";

/** "12", or "50+" when the first page was full (these lists have no totals). */
function countOf<T>(q: ListQuery<T>): string | null {
  if (!q.data) return null;
  const n = flattenPages(q.data).length;
  return q.data.pages.at(-1)?.page.has_more ? `${n}+` : String(n);
}

/** A dashboard block: heading + count on the left, "전체 보기" on the right, then its table or list. */
function Block({ title, count, moreHref, children }: { title: string; count?: string | null; moreHref?: string; children: ReactNode }) {
  const t = useTranslations();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <div className="flex h-7 items-center justify-between gap-3">
        <h2 id={headingId} className="flex items-baseline gap-2 text-heading text-fg">
          {title}
          {count ? <span className="num text-small font-normal text-fg-muted">{count}</span> : null}
        </h2>
        {moreHref ? (
          <Link href={moreHref} className={cn("flex items-center gap-1 rounded-sm text-small text-fg-muted hover:text-fg", focusRing)}>
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
  if (rows.length === 0) return <div className="rounded-md border border-dashed border-border-strong">{empty}</div>;
  return <>{children(rows)}</>;
}

/** Empty block with its next action. */
function Empty({ title, href, action }: { title: string; href: string; action: string }) {
  return (
    <EmptyState
      className="py-8"
      title={title}
      action={
        <Link href={href} className={buttonClass("secondary", "sm")}>
          {action}
        </Link>
      }
    />
  );
}

function StatLink({ href, label, value, hint, warn }: { href: string; label: string; value: string | null; hint: string; warn?: boolean }) {
  return (
    <Link href={href} className={cn("group flex min-w-0 flex-col gap-1 bg-bg-panel px-4 py-3 hover:bg-bg-hover", focusRing, "focus-visible:-outline-offset-2")}>
      <span className="text-caption text-fg-muted">{label}</span>
      <span className={cn("num text-title", warn ? "text-warning" : "text-fg")}>{value ?? "—"}</span>
      <span className="truncate text-small text-fg-muted group-hover:text-fg">{hint}</span>
    </Link>
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
      {(events) => (
        <ol aria-label={t("dashboard.activityList")} className="flex flex-col rounded-md border border-border bg-bg-panel">
          {groupActivity(events).slice(0, 6).map(({ event: e, repeat }) => {
            const system = e.actor.type === "SYSTEM" || !e.actor.display_name;
            const actor = e.actor.display_name ?? t("activity.system");
            return (
              <li key={e.audit_event_id} className="flex items-start gap-3 border-b border-border px-3 py-2.5 last:border-b-0">
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
                  <p className="mt-0.5 flex flex-wrap gap-x-2 text-caption text-fg-muted">
                    <span className="num font-mono">
                      <DateTime value={e.occurred_at} />
                    </span>
                    <span>{t(`enums.ResourceType.${e.resource.type}`)}</span>
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </QueryBody>
  );
}

/**
 * Dashboard (spec §6): facts first (no greeting), a stat strip, what to act on (review queue / my open requests) beside
 * recent activity, the institute's latest dataset versions, then my projects and grants. Every empty block offers the
 * next step; every block loads and fails on its own.
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
  const expiring = useMemo(() => {
    const now = Date.now();
    return grantRows.filter((g) => Date.parse(g.expires_at) - now <= WEEK_MS).length;
  }, [grantRows]);
  const queue = steward ? review : myRequests;
  const queueCount = countOf(queue);
  const queueHref = steward ? "/commons/access?tab=review" : "/commons/access?tab=requests";
  const latest = flattenPages(datasets.data).find((d) => d.latest_version_label);
  const orgDatasets = t("dashboard.orgDatasets", { org: me.organization.name });

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
    steward
      ? {
          key: "requester",
          header: t("dashboard.columns.requester"),
          cell: (r) => (
            <span className="flex min-w-0 items-center gap-2">
              <Avatar name={r.requester_display_name ?? "?"} size={20} decorative />
              <span className="truncate">{t("dashboard.requestedBy", { name: r.requester_display_name ?? "—" })}</span>
              <span className="truncate text-fg-muted">{orgNames[r.requester_organization_id] ?? ""}</span>
            </span>
          ),
        }
      : { key: "project", header: t("dashboard.columns.project"), cell: (r) => <span className="text-fg-muted">{r.project_name ?? "—"}</span> },
    { key: "purpose", header: t("dashboard.columns.purpose"), cell: (r) => t(`enums.Purpose.${r.purpose}`) },
    { key: "days", header: t("dashboard.columns.days"), numeric: true, cell: (r) => t("dashboard.days", { count: r.requested_days }) },
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
    { key: "role", header: t("dashboard.columns.myRole"), cell: (p) => (p.my_role ? t(`enums.ProjectRole.${p.my_role}`) : "—") },
    { key: "members", header: t("dashboard.columns.members"), numeric: true, cell: (p) => p.member_count ?? "—" },
  ];

  const grantColumns: DataColumn<AccessGrant>[] = [
    {
      key: "dataset",
      header: t("dashboard.columns.dataset"),
      cell: (g) => (
        <Link href={`/commons/data/${g.dataset_id}`} className={linkClass}>
          {g.dataset_title ?? g.dataset_id}
        </Link>
      ),
    },
    { key: "expires", header: t("dashboard.columns.expires"), cell: (g) => <ExpiryText value={g.expires_at} /> },
  ];

  const facts = (
    <>
      <Link href={queueHref} className="hover:text-fg">
        {t(steward ? "dashboard.factReview" : "dashboard.factRequests", { count: queueCount ?? "—" })}
      </Link>
      <span aria-hidden="true">·</span>
      <Link href="/commons/access?tab=grants" className={cn("hover:text-fg", expiring > 0 && "font-medium text-warning")}>
        {t("dashboard.factExpiring", { count: grants.data ? String(expiring) : "—" })}
      </Link>
      {latest ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="min-w-0">
            {t("dashboard.factLatest")}{" "}
            <Link href={`/commons/data/${latest.dataset_id}`} className="text-fg hover:underline">
              {latest.title}
            </Link>
            {latest.latest_version_label ? <span className="ml-1 font-mono text-mono">{latest.latest_version_label}</span> : null}
          </span>
        </>
      ) : null}
    </>
  );

  return (
    <>
      <PageHeader title={t("dashboard.title")} meta={facts} />
      <div className="flex flex-col gap-8">
        <ul aria-label={t("dashboard.summary")} className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border lg:grid-cols-4 [&>li]:flex [&>li]:bg-bg-panel [&>li>a]:flex-1">
          <li><StatLink href="/commons/projects" label={t("dashboard.stat.projects")} value={countOf(projects)} hint={t("dashboard.stat.projectsHint")} /></li>
          <li><StatLink
            href={queueHref}
            label={t("dashboard.stat.review")}
            value={queueCount}
            hint={t(steward ? "dashboard.stat.reviewHintSteward" : "dashboard.stat.reviewHint")}
          /></li>
          <li><StatLink href="/commons/access?tab=grants" label={t("dashboard.stat.grants")} value={countOf(grants)} hint={t("dashboard.stat.grantsHint")} /></li>
          <li><StatLink
            href="/commons/access?tab=grants"
            label={t("dashboard.stat.expiring")}
            value={grants.data ? String(expiring) : null}
            hint={t("dashboard.stat.expiringHint")}
            warn={expiring > 0}
          /></li>
        </ul>

        <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <Block title={t(steward ? "dashboard.reviewQueue" : "dashboard.openRequests")} count={queueCount} moreHref={queueHref}>
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
                  columns={requestColumns}
                  rows={rows.slice(0, 6)}
                  rowKey={(r) => r.access_request_id}
                />
              )}
            </QueryBody>
          </Block>
          <Block title={t("dashboard.recentActivity")} moreHref="/commons/activity">
            <ActivityList query={activity} />
          </Block>
        </div>

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

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
          <Block title={t("dashboard.myProjects")} count={countOf(projects)} moreHref="/commons/projects">
            <QueryBody query={projects} empty={<Empty title={t("dashboard.noProjects")} href="/commons/projects/new" action={t("dashboard.createFirstProject")} />}>
              {(rows) => <DataTable caption={t("dashboard.myProjects")} columns={projectColumns} rows={rows.slice(0, 5)} rowKey={(p) => p.project_id} />}
            </QueryBody>
          </Block>
          <Block title={t("dashboard.myGrants")} count={countOf(grants)} moreHref="/commons/access?tab=grants">
            <QueryBody query={grants} empty={<Empty title={t("dashboard.noGrants")} href="/commons/data" action={t("dashboard.findData")} />}>
              {(rows) => (
                <DataTable
                  caption={t("dashboard.myGrants")}
                  columns={grantColumns}
                  rows={[...rows].sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at)).slice(0, 5)}
                  rowKey={(g) => g.access_grant_id}
                />
              )}
            </QueryBody>
          </Block>
        </div>
      </div>
    </>
  );
}
