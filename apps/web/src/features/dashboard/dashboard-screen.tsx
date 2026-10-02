"use client";
import { Avatar, avatarTone, Badge, buttonClass, cn, focusRing, initials } from "@nais/ui";
import {
  ArrowDownRight, ArrowRight, ArrowUpRight, CircleCheck, CircleDashed, CircleX, Clock, Cog, LoaderCircle, Minus, TriangleAlert, type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useSearchDatasets, useVocabularyLabels } from "@/features/catalog/api";
import { useListAccessGrants, useListAccessRequests } from "@/features/governance/api";
import { useOrgNames } from "@/features/organizations/api";
import { useListProjects } from "@/features/projects/api";
import { flattenPages } from "@/shared/api/pagination";
import type { AccessGrant, AccessRequest, AuditEvent, ReadinessOverall, Schemas } from "@/shared/api/types";
import { hasOrgRole, useMeData } from "@/shared/hooks/use-me";
import { ReadinessBadge, RequestStatusBadge } from "@/shared/ui/badges";
import { ScreenTitle } from "@/shared/ui/screen-v2";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { ActivityChart, FieldBars, KIND_COLOR, RemainingBar, SegmentBar, Sparkline } from "./charts";
import { useAuditWindow, useHealthRows, type HealthRow } from "./dashboard-data";
import {
  bucketByDay, cumulativeEndingAt, dailySeries, DAY_MS, dayKey, dayKeys, daysSince, daysUntil, decisions, groupRuns, KINDS, kindOf, remainingShare, sum,
  weekOverWeek, windowStart,
} from "./derive";
import "./dashboard.css";

type Hit = Schemas["DatasetSearchHit"];
type SearchResult = Schemas["DatasetSearchResult"];

const LIST_LIMIT = 50;
const HEALTH_ROWS = 6;
const PENDING = new Set<AccessRequest["status"]>(["SUBMITTED", "UNDER_REVIEW"]);
const OPEN = new Set<AccessRequest["status"]>(["SUBMITTED", "UNDER_REVIEW", "CHANGE_REQUESTED"]);
const nf = new Intl.NumberFormat("ko-KR");
const linkClass = cn("rounded-xs font-medium text-fg underline-offset-4 hover:underline", focusRing);

/** "9.26" (Seoul) from a day key or an ISO timestamp. */
const shortDay = (keyOrIso: string) => {
  const key = keyOrIso.length === 10 ? keyOrIso : dayKey(Date.parse(keyOrIso));
  return `${Number(key.slice(5, 7))}.${Number(key.slice(8, 10))}`;
};

function useAgo() {
  const t = useTranslations();
  return (iso: string, now: number) => {
    const min = Math.floor((now - Date.parse(iso)) / 60_000);
    if (min < 1) return t("dashboard.ago.now");
    if (min < 60) return t("dashboard.ago.minutes", { count: min });
    if (min < 24 * 60) return t("dashboard.ago.hours", { count: Math.floor(min / 60) });
    return t("dashboard.ago.days", { count: Math.floor(min / (24 * 60)) });
  };
}

/* ── Frame ─────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** A panel: accent eyebrow, bold title, mono count, "전체 보기" on the right; a 1px rule between header and body. */
function Panel({ eyebrow, title, count, href, className, children }: { eyebrow: string; title: string; count?: ReactNode; href?: string; className?: string; children: ReactNode }) {
  const t = useTranslations();
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn("flex min-w-0 flex-col overflow-hidden rounded-md border border-border bg-bg-panel", className)}>
      <header className="flex min-h-11 items-center justify-between gap-3 border-b border-border px-4 py-2">
        <div className="flex min-w-0 items-baseline gap-2">
          {/* The shared crumb's type (screen-v2: sv-kicker / sv-h2 / sv-count), laid inline to fit the panel's head bar. */}
          <span aria-hidden="true" className="sv-kicker shrink-0">
            {eyebrow}
          </span>
          <h2 id={id} className="sv-h2 truncate">
            {title}
            {count !== undefined && count !== null ? <span className="sv-count ml-1.5">{count}</span> : null}
          </h2>
        </div>
        {href ? (
          <Link href={href} className={cn("flex shrink-0 items-center gap-1 whitespace-nowrap rounded-xs text-small text-fg-muted hover:text-fg", focusRing)}>
            {t("dashboard.viewAll")}
            <ArrowRight aria-hidden="true" strokeWidth={1.75} className="size-3.5" />
          </Link>
        ) : null}
      </header>
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </section>
  );
}

function Loading() {
  return (
    <div className="px-4 py-3">
      <DelayedSkeleton lines={3} />
    </div>
  );
}

function Failed({ error, retry }: { error: unknown; retry: () => unknown }) {
  return (
    <div className="px-4 py-3">
      <ErrorView error={error} onRetry={() => void retry()} />
    </div>
  );
}

/** Empty body that still says something useful: a line, a hint, optional context, and the next step. */
function EmptyBody({ title, hint, href, action, children }: { title: string; hint?: string; href?: string; action?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col justify-center gap-3 px-4 py-5">
      <div>
        <p className="text-small font-medium text-fg">{title}</p>
        {hint ? <p className="mt-0.5 text-small text-fg-muted">{hint}</p> : null}
      </div>
      {children}
      {href && action ? (
        <Link href={href} className={cn(buttonClass("secondary", "sm"), "self-start")}>
          {action}
          <ArrowRight aria-hidden="true" strokeWidth={1.75} className="size-3.5" />
        </Link>
      ) : null}
    </div>
  );
}

/* ── KPI strip ─────────────────────────────────────────────────────────────────────────────────────────────────── */

type Tile = { key: string; href: string; label: string; value: number | null; foot: ReactNode; delta?: ReactNode; trend: ReactNode; warn?: boolean };

function KpiStrip({ tiles, label }: { tiles: Tile[]; label: string }) {
  return (
    <section aria-label={label} className="lg:col-span-12">
      <ul className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border lg:grid-cols-5">
        {tiles.map((s, i) => (
          <li key={s.key} className={cn("flex bg-bg-panel", i === tiles.length - 1 && tiles.length % 2 === 1 && "col-span-2 lg:col-span-1")}>
            <Link href={s.href} className={cn("flex min-w-0 flex-1 flex-col px-4 pb-3.5 pt-3 transition-colors duration-150 hover:bg-bg-subtle", focusRing, "focus-visible:-outline-offset-2")}>
              <span className="truncate text-small text-fg-muted">{s.label}</span>
              <span className="mt-1 flex items-baseline gap-2">
                <span data-kpi-value="" className={cn("text-[28px] font-[680] leading-8 tracking-[-0.035em]", s.warn ? "text-warning" : "text-fg")}>
                  {s.value === null ? "—" : nf.format(s.value)}
                </span>
                {s.delta}
              </span>
              <span className={cn("mt-0.5 truncate text-caption font-normal", s.warn ? "text-warning" : "text-fg-muted")}>{s.foot}</span>
              <span className="mt-auto block pt-3">{s.trend}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Signed week-over-week change; colour = direction × whether up is good (more downloads is good). */
function Delta({ ratio }: { ratio: number | null }) {
  const t = useTranslations();
  if (ratio === null || !Number.isFinite(ratio) || Math.round(ratio * 100) === 0) return null;
  const up = ratio > 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  const pct = `${up ? "+" : "−"}${Math.abs(Math.round(ratio * 100))}%`;
  return (
    <span className={cn("num flex items-center gap-0.5 text-caption", up ? "text-success" : "text-fg-muted")}>
      <Icon aria-hidden="true" strokeWidth={2} className="size-3.5" />
      <span className="sr-only">{t("dashboard.kpi.wow", { pct })}</span>
      <span aria-hidden="true">{pct}</span>
    </span>
  );
}

function AddedChip({ count }: { count: number }) {
  const t = useTranslations();
  if (count <= 0) return null;
  return <span className="num text-caption text-accent-fg">{t("dashboard.kpi.added", { count })}</span>;
}

/* ── Readiness ─────────────────────────────────────────────────────────────────────────────────────────────────── */

const STATUS: { key: ReadinessOverall | "NONE"; color: string; text: string; icon: LucideIcon }[] = [
  { key: "PASS", color: "var(--color-success-solid)", text: "text-success", icon: CircleCheck },
  { key: "WARNING", color: "var(--color-warning-solid)", text: "text-warning", icon: TriangleAlert },
  { key: "FAIL", color: "var(--color-danger-solid)", text: "text-danger", icon: CircleX },
  { key: "NONE", color: "var(--color-chart-muted)", text: "text-fg-muted", icon: CircleDashed },
];

function readinessCounts(r: SearchResult | undefined) {
  const facet = r?.facets.readiness_status ?? [];
  const of = (v: string) => facet.find((b) => b.value === v)?.count ?? 0;
  const PASS = of("PASS");
  const WARNING = of("WARNING");
  const FAIL = of("FAIL");
  const total = r?.total ?? 0;
  return { PASS, WARNING, FAIL, NONE: Math.max(0, total - PASS - WARNING - FAIL), total };
}

function ReadinessScope({ name, result, emphasis }: { name: string; result: SearchResult; emphasis?: boolean }) {
  const t = useTranslations();
  const c = readinessCounts(result);
  const statusLabel = (k: ReadinessOverall | "NONE") => (k === "NONE" ? t("dashboard.readiness.notValidated") : t(`enums.ReadinessOverall.${k}`));
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-baseline justify-between gap-3 text-small">
        <span className={cn("truncate", emphasis ? "font-semibold text-fg" : "text-fg-muted")}>{name}</span>
        <span className="num shrink-0 text-small text-fg-muted">{t("dashboard.readiness.count", { count: c.total })}</span>
      </p>
      <SegmentBar parts={STATUS.map((s) => ({ key: s.key, value: c[s.key], color: s.color }))} className={emphasis ? "h-2.5" : undefined} />
      <ul aria-label={t("dashboard.readiness.label", { scope: name, pass: c.PASS, warning: c.WARNING, fail: c.FAIL, none: c.NONE })} className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-4">
        {STATUS.map(({ key, icon: Icon, text }) => (
          <li key={key} className="flex min-w-0 items-center gap-1 text-caption font-normal text-fg-muted">
            <Icon aria-hidden="true" strokeWidth={2} className={cn("size-3.5 shrink-0", text)} />
            <span className="truncate">{statusLabel(key)}</span>
            <span className="num ml-auto font-mono font-medium text-fg">{c[key]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── Work queue ────────────────────────────────────────────────────────────────────────────────────────────────── */

function ReviewRows({ rows, now }: { rows: AccessRequest[]; now: number }) {
  const t = useTranslations();
  const orgNames = useOrgNames();
  return (
    <ul className="divide-y divide-border">
      {rows.map((r) => {
        const waited = daysSince(r.created_at, now);
        const name = r.requester_display_name ?? "—";
        const title = r.dataset_title ?? r.dataset_id;
        return (
          <li key={r.access_request_id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2.5 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]">
            <Avatar name={name} size={24} decorative />
            <div className="min-w-0">
              <Link href={`/commons/access/${r.access_request_id}`} className={cn(linkClass, "block truncate text-small")}>
                {title}
              </Link>
              <p className="truncate text-caption font-normal text-fg-muted">
                {t("dashboard.queue.requester", { name, org: orgNames[r.requester_organization_id] ?? "" })} · {t(`enums.Purpose.${r.purpose}`)} ·{" "}
                {t("dashboard.queue.days", { count: r.requested_days })}
              </p>
            </div>
            <span className={cn("num hidden items-center gap-1 whitespace-nowrap text-small sm:flex", waited >= 3 ? "font-medium text-warning" : "text-fg-muted")}>
              <Clock aria-hidden="true" strokeWidth={1.75} className="size-3.5" />
              {waited > 0 ? t("dashboard.queue.waited", { days: waited }) : t("dashboard.queue.today")}
            </span>
            <Link
              href={`/commons/access/${r.access_request_id}`}
              aria-label={`${t("dashboard.queue.reviewAction")}: ${title}`}
              className={buttonClass("secondary", "sm")}
            >
              {t("dashboard.queue.reviewAction")}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

const STEP: Partial<Record<AccessRequest["status"], number>> = { SUBMITTED: 1, UNDER_REVIEW: 2, CHANGE_REQUESTED: 2 };

function MyRequestRows({ rows, now }: { rows: AccessRequest[]; now: number }) {
  const t = useTranslations();
  const orgNames = useOrgNames();
  return (
    <ul className="divide-y divide-border">
      {rows.map((r) => {
        const step = STEP[r.status] ?? 1;
        const change = r.status === "CHANGE_REQUESTED";
        const waited = daysSince(r.created_at, now);
        const title = r.dataset_title ?? r.dataset_id;
        return (
          <li key={r.access_request_id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-2.5 sm:grid-cols-[minmax(0,1fr)_9rem_auto]">
            <div className="min-w-0">
              <Link href={`/commons/access/${r.access_request_id}`} className={cn(linkClass, "block truncate text-small")}>
                {title}
              </Link>
              <p className="truncate text-caption font-normal text-fg-muted">
                {orgNames[r.owner_organization_id] ?? "—"} · {r.project_name ?? "—"} · {waited > 0 ? t("dashboard.queue.waited", { days: waited }) : t("dashboard.queue.today")}
              </p>
            </div>
            <div className="hidden min-w-0 flex-col gap-1 sm:flex">
              <span aria-hidden="true" className="flex gap-[2px]">
                {[1, 2, 3].map((s) => (
                  <span key={s} className={cn("h-1 flex-1 rounded-full", s <= step ? (change && s === step ? "bg-warning-solid" : "bg-accent") : "bg-bg-active")} />
                ))}
              </span>
              <span className={cn("flex items-center gap-1 truncate text-caption font-normal", change ? "text-warning" : "text-fg-muted")}>
                {change ? <TriangleAlert aria-hidden="true" strokeWidth={2} className="size-3 shrink-0" /> : null}
                <span className="sr-only">{t("dashboard.queue.steps", { step })} · </span>
                {t(`dashboard.queue.next.${r.status as "SUBMITTED" | "UNDER_REVIEW" | "CHANGE_REQUESTED"}`)}
              </span>
            </div>
            <Link
              href={`/commons/access/${r.access_request_id}`}
              aria-label={`${change ? t("dashboard.queue.fixAction") : t("dashboard.queue.openAction")}: ${title}`}
              className={buttonClass(change ? "primary" : "secondary", "sm")}
            >
              {change ? t("dashboard.queue.fixAction") : t("dashboard.queue.openAction")}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** Recently decided requests under a short queue, so a quiet queue still shows how requests went. */
function DecidedRows({ rows, now, steward }: { rows: AccessRequest[]; now: number; steward: boolean }) {
  const t = useTranslations();
  const ago = useAgo();
  const orgNames = useOrgNames();
  return (
    <div className="border-t border-border">
      <p className="bg-bg-subtle px-4 py-1.5 text-caption font-medium text-fg-muted">{t("dashboard.queue.decided")}</p>
      <ul className="divide-y divide-border border-t border-border">
        {rows.map((r) => (
          <li key={r.access_request_id} className="flex items-center gap-3 px-4 py-2">
            <span className="w-[5.5rem] shrink-0">
              <RequestStatusBadge status={r.status} />
            </span>
            <Link href={`/commons/access/${r.access_request_id}`} className={cn(linkClass, "min-w-0 flex-1 truncate text-small font-normal")}>
              {r.dataset_title ?? r.dataset_id}
            </Link>
            <span className="hidden truncate text-caption font-normal text-fg-muted sm:block">
              {steward ? (r.requester_display_name ?? "—") : (orgNames[r.owner_organization_id] ?? "—")}
            </span>
            <time dateTime={r.updated_at} className="num w-16 shrink-0 whitespace-nowrap text-right text-caption font-normal text-fg-muted">
              {ago(r.updated_at, now)}
            </time>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── Grants ────────────────────────────────────────────────────────────────────────────────────────────────────── */

function GrantRows({ rows, now, owner }: { rows: AccessGrant[]; now: number; owner: boolean }) {
  const t = useTranslations();
  return (
    <ul className="divide-y divide-border">
      {rows.map((g) => {
        const days = daysUntil(g.expires_at, now);
        const warn = Date.parse(g.expires_at) - now <= 7 * DAY_MS;
        const share = remainingShare(g, now);
        return (
          <li key={g.access_grant_id} className="flex flex-col gap-1.5 px-4 py-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <Link href={`/commons/data/${g.dataset_id}`} className={cn(linkClass, "truncate text-small")}>
                {g.dataset_title ?? g.dataset_id}
              </Link>
              <span className={cn("num flex shrink-0 items-center gap-1 font-mono text-mono", warn ? "font-semibold text-warning" : "text-fg-muted")}>
                {warn ? <Clock aria-hidden="true" strokeWidth={2} className="size-3.5" /> : null}
                {days === 0 ? t("dashboard.grants.today") : t("dashboard.grants.dday", { days })}
              </span>
            </div>
            <RemainingBar share={share} warn={warn} />
            <p className="flex justify-between gap-3 text-caption font-normal text-fg-muted">
              <span className="truncate">{owner ? (g.subject_display_name ?? "—") : (g.project_name ?? "—")}</span>
              <span className="num shrink-0 font-mono">
                <span className="sr-only">{t("dashboard.grants.remaining", { pct: `${Math.round(share * 100)}%` })} · </span>
                {shortDay(g.expires_at)}
              </span>
            </p>
          </li>
        );
      })}
    </ul>
  );
}

/* ── Health table ──────────────────────────────────────────────────────────────────────────────────────────────── */

const PREVIEW_ICON: Record<string, [LucideIcon, string]> = {
  READY: [CircleCheck, "text-success"],
  PENDING: [LoaderCircle, "text-info"],
  FAILED: [CircleX, "text-danger"],
  UNSUPPORTED: [Minus, "text-fg-muted"],
  NONE: [Minus, "text-fg-muted"],
};

function ScoreCell({ row }: { row: HealthRow }) {
  const t = useTranslations();
  if (!row.versionId) return <span className="text-caption font-normal text-fg-muted">{t("dashboard.health.draftOnly")}</span>;
  if (!row.score) return row.loading ? <span className="text-fg-subtle">…</span> : <ReadinessBadge value={row.readiness} />;
  const { pass, total } = row.score;
  const status = STATUS.find((s) => s.key === (row.readiness ?? "NONE"))!;
  const Icon = status.icon;
  return (
    <span className="flex items-center gap-2">
      <Icon aria-hidden="true" strokeWidth={2} className={cn("size-3.5 shrink-0", status.text)} />
      <span aria-hidden="true" className="hidden h-1.5 w-16 gap-px overflow-hidden rounded-full md:flex">
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className="h-full flex-1" style={{ background: i < pass ? "var(--color-success-solid)" : status.color }} />
        ))}
      </span>
      <span className="num whitespace-nowrap text-small text-fg">
        <span className="sr-only">{row.readiness ? t(`enums.ReadinessOverall.${row.readiness}`) : ""} </span>
        {t("dashboard.health.score", { pass, total })}
      </span>
    </span>
  );
}

function PreviewCell({ row }: { row: HealthRow }) {
  const t = useTranslations();
  if (!row.versionId) return <span className="text-fg-subtle">—</span>;
  if (!row.preview) return <span className="text-fg-subtle">…</span>;
  const [Icon, tone] = PREVIEW_ICON[row.preview]!;
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-small text-fg-muted">
      <Icon aria-hidden="true" strokeWidth={2} className={cn("size-3.5 shrink-0", tone)} />
      {row.preview === "NONE" ? t("dashboard.health.noPreview") : t(`enums.FilePreviewStatus.${row.preview}`)}
    </span>
  );
}

function HealthTable({ hits, now, caption }: { hits: Hit[]; now: number; caption: string }) {
  const t = useTranslations();
  const ago = useAgo();
  const rows = useHealthRows(hits);
  const th = "px-4 py-2 text-left text-caption font-medium text-fg-muted first:pl-4";
  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full table-fixed border-collapse text-small">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b border-border bg-bg-subtle">
          <tr>
            <th scope="col" className={th}>
              {t("dashboard.health.columns.dataset")}
            </th>
            <th scope="col" className={cn(th, "hidden w-[4.5rem] sm:table-cell")}>
              {t("dashboard.health.columns.version")}
            </th>
            <th scope="col" className={cn(th, "w-[8.5rem] md:w-[11rem]")}>
              {t("dashboard.health.columns.readiness")}
            </th>
            <th scope="col" className={cn(th, "hidden w-[7rem] md:table-cell")}>
              {t("dashboard.health.columns.preview")}
            </th>
            <th scope="col" className={cn(th, "hidden w-[6rem] text-right sm:table-cell")}>
              {t("dashboard.health.columns.published")}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.hit.dataset_id} className="align-middle">
              <td className="px-4 py-2.5">
                <Link href={`/commons/data/${row.hit.dataset_id}`} className={cn(linkClass, "block truncate")}>
                  {row.hit.title}
                </Link>
                <p className="truncate text-caption font-normal text-fg-muted">{t(`enums.AccessLevel.${row.hit.access_level}`)}{row.hit.subtitle ? ` · ${row.hit.subtitle}` : ""}</p>
              </td>
              <td className="hidden px-4 py-2.5 font-mono text-mono text-fg sm:table-cell">{row.hit.latest_version_label ?? "—"}</td>
              <td className="px-4 py-2.5">
                <ScoreCell row={row} />
              </td>
              <td className="hidden px-4 py-2.5 md:table-cell">
                <PreviewCell row={row} />
              </td>
              <td className="num hidden whitespace-nowrap px-4 py-2.5 text-right text-small text-fg-muted sm:table-cell">
                {row.publishedAt ? <time dateTime={row.publishedAt}>{ago(row.publishedAt, now)}</time> : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Feeds ─────────────────────────────────────────────────────────────────────────────────────────────────────── */

const ORG_TONE = ["bg-bg-active text-fg-muted", "bg-accent-soft text-accent-fg", "bg-info-soft text-info", "bg-success-soft text-success", "bg-warning-soft text-warning"] as const;

/** Institute mark: square initial (people get round avatars). */
function OrgMark({ name }: { name: string }) {
  const short = name.replace(/^한국/, "").trim() || name;
  return (
    <span aria-hidden="true" className={cn("flex size-7 shrink-0 select-none items-center justify-center rounded-sm text-caption font-semibold", ORG_TONE[avatarTone(name)])}>
      {initials(short)}
    </span>
  );
}

function PortalFeed({ hits, now }: { hits: Hit[]; now: number }) {
  const ago = useAgo();
  return (
    <ul className="divide-y divide-border">
      {hits.map((h) => (
        <li key={h.dataset_id} className="flex items-center gap-3 px-4 py-2.5">
          <OrgMark name={h.owner_organization_name ?? ""} />
          <div className="min-w-0 flex-1">
            <Link href={`/commons/data/${h.dataset_id}`} className={cn(linkClass, "block truncate text-small")}>
              {h.title}
            </Link>
            <p className="truncate text-caption font-normal text-fg-muted">
              {h.owner_organization_name ?? "—"}
              {h.latest_version_label ? (
                <>
                  {" · "}
                  <span className="font-mono">{h.latest_version_label}</span>
                </>
              ) : null}
              {h.updated_at ? ` · ${ago(h.updated_at, now)}` : ""}
            </p>
          </div>
          <span className="hidden shrink-0 sm:block">
            <ReadinessBadge value={h.readiness_overall} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function RecentFeed({ events, now }: { events: AuditEvent[]; now: number }) {
  const t = useTranslations();
  const ago = useAgo();
  return (
    <ol aria-label={t("dashboard.recent.list")} className="divide-y divide-border">
      {groupRuns(events)
        .slice(0, 8)
        .map(({ event: e, repeat }) => {
          const system = e.actor.type === "SYSTEM" || !e.actor.display_name;
          const actor = e.actor.display_name ?? t("activity.system");
          return (
            <li key={e.audit_event_id} className="flex items-center gap-2.5 px-4 py-2">
              {system ? (
                <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center rounded-full bg-bg-active text-fg-muted">
                  <Cog strokeWidth={1.75} className="size-3" />
                </span>
              ) : (
                <Avatar name={actor} size={20} decorative />
              )}
              <p className="min-w-0 flex-1 truncate text-small text-fg">
                <span className="font-medium">{actor}</span> <span className="text-fg-muted">{t(`enums.AuditAction.${e.action}`)}</span>
                {repeat > 1 ? <span className="num ml-1 font-mono text-mono text-fg-muted">{t("dashboard.recent.repeat", { count: repeat })}</span> : null}
                {e.result === "DENIED" ? (
                  <Badge tone="danger" className="ml-1.5 align-middle">
                    {t("activity.result.DENIED")}
                  </Badge>
                ) : null}
              </p>
              <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full" style={{ background: KIND_COLOR[kindOf(e.action)] }} />
              <time dateTime={e.occurred_at} className="num w-16 shrink-0 whitespace-nowrap text-right text-caption font-normal text-fg-muted">
                {ago(e.occurred_at, now)}
              </time>
            </li>
          );
        })}
    </ol>
  );
}

/** Nothing recorded yet: the three things that start a record, each a link. */
function FirstSteps() {
  const t = useTranslations();
  const steps: [string, string, string][] = [
    ["/commons/data", t("dashboard.recent.steps.find"), t("dashboard.recent.steps.findHint")],
    ["/commons/projects", t("dashboard.recent.steps.project"), t("dashboard.recent.steps.projectHint")],
    ["/commons/access?tab=requests", t("dashboard.recent.steps.request"), t("dashboard.recent.steps.requestHint")],
  ];
  return (
    <div className="flex flex-1 flex-col">
      <p className="px-4 pb-1 pt-3 text-small text-fg-muted">{t("dashboard.recent.empty")}</p>
      <ol className="flex flex-col py-1">
        {steps.map(([href, title, hint], i) => (
          <li key={href}>
            <Link href={href} className={cn("group flex items-center gap-3 px-4 py-2.5 hover:bg-bg-subtle", focusRing, "focus-visible:-outline-offset-2")}>
              <span aria-hidden="true" className="num flex size-6 shrink-0 items-center justify-center rounded-full border border-border font-mono text-caption text-fg-muted">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-small font-medium text-fg">{title}</span>
                <span className="block truncate text-caption font-normal text-fg-muted">{hint}</span>
              </span>
              <ArrowRight aria-hidden="true" strokeWidth={1.75} className="size-3.5 shrink-0 text-fg-muted" />
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ── Screen ────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** Once per browser session the marks grow in from their baselines; afterwards the dashboard opens still. */
function useEntrance() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    try {
      if (sessionStorage.getItem("nais.dash.entered")) return;
      sessionStorage.setItem("nais.dash.entered", "1");
      setOn(true);
    } catch {
      /* storage blocked: no entrance */
    }
  }, []);
  return on;
}

/**
 * Dashboard: the state of the user's research-data world at a glance. A KPI strip with 30-day trends, institute (or
 * personal) activity by kind, AI-ready status, the work queue, grant expiry, the institute's data health, data by
 * field across the council and what other institutes just updated. Every figure comes from existing list/search
 * operations; each panel loads, fails and empties on its own and an empty panel still shows the portal around it.
 */
export function DashboardScreen() {
  const t = useTranslations();
  const me = useMeData();
  const orgId = me.organization.organization_id;
  const orgName = me.organization.name;
  const steward = hasOrgRole(me, "DATA_STEWARD");
  const orgAdmin = hasOrgRole(me, "ORG_ADMIN");
  const platformAdmin = me.platform_roles.includes("PLATFORM_ADMIN");
  const staff = steward || orgAdmin;
  const entrance = useEntrance();
  const vocab = useVocabularyLabels();

  const [now] = useState(() => Date.now());
  const from = useMemo(() => new Date(windowStart(now)).toISOString(), [now]);
  const keys = useMemo(() => dayKeys(now), [now]);

  // Queries (existing operations only).
  const orgSearch = useSearchDatasets({ owner_organization_id: [orgId], sort: "updated_desc", limit: LIST_LIMIT });
  const portalSearch = useSearchDatasets({ sort: "updated_desc", limit: 6 });
  const audit = useAuditWindow(from);
  const review = useListAccessRequests({ role: "reviewer", limit: LIST_LIMIT }, { enabled: steward });
  const mine = useListAccessRequests({ role: "requester", limit: LIST_LIMIT });
  const myGrants = useListAccessGrants({ role: "subject", status: ["ACTIVE"], limit: LIST_LIMIT });
  const ownerGrants = useListAccessGrants({ role: "owner", status: ["ACTIVE"], limit: LIST_LIMIT }, { enabled: staff });
  const projects = useListProjects({ scope: "mine", limit: LIST_LIMIT });

  const orgResult = orgSearch.data?.pages[0] as SearchResult | undefined;
  const portalResult = portalSearch.data?.pages[0] as SearchResult | undefined;
  const orgHits = useMemo(() => flattenPages(orgSearch.data) as Hit[], [orgSearch.data]);
  const reviewRows = useMemo(() => flattenPages(review.data), [review.data]);
  const mineRows = useMemo(() => flattenPages(mine.data), [mine.data]);
  const grantsQuery = staff ? ownerGrants : myGrants;
  const grantRows = useMemo(() => [...flattenPages(grantsQuery.data)].sort((a, b) => a.expires_at.localeCompare(b.expires_at)), [grantsQuery.data]);
  const myGrantRows = useMemo(() => flattenPages(myGrants.data), [myGrants.data]);
  const projectRows = useMemo(() => flattenPages(projects.data), [projects.data]);

  // Derived series.
  const events = audit.events;
  const inWindow = useMemo(() => events.filter((e) => Date.parse(e.occurred_at) >= Date.parse(from)), [events, from]);
  const buckets = useMemo(() => bucketByDay(inWindow, keys), [inWindow, keys]);
  const ownData = (e: AuditEvent) => e.resource.owner_organization_id === orgId;
  const isMine = (e: AuditEvent) => e.actor.user_id === me.user_id;
  const downloadsDaily = dailySeries(inWindow, keys, (e) => e.action === "FILE_DOWNLOADED" && (platformAdmin ? true : staff ? ownData(e) : isMine(e)));
  const publishedDaily = dailySeries(inWindow, keys, (e) => e.action === "DATASET_VERSION_PUBLISHED" && ownData(e));
  const createdDaily = dailySeries(inWindow, keys, (e) => e.action === "DATASET_CREATED" && ownData(e));
  const requestedDaily = dailySeries(inWindow, keys, (e) => e.action === "ACCESS_REQUESTED" && (staff ? ownData(e) : isMine(e)));
  const activeGrantsLine = (rows: AccessGrant[]) => keys.map((_, i) => {
    const end = windowStart(now) + (i + 1) * DAY_MS;
    return rows.filter((g) => Date.parse(g.valid_from) < end && Date.parse(g.expires_at) > Math.min(end, now)).length;
  });
  const pendingReview = reviewRows.filter((r) => PENDING.has(r.status)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const decided = decisions(reviewRows, Date.parse(from));
  const openMine = mineRows.filter((r) => OPEN.has(r.status)).sort((a, b) => Number(b.status === "CHANGE_REQUESTED") - Number(a.status === "CHANGE_REQUESTED") || a.created_at.localeCompare(b.created_at));
  const expiringCount = (rows: AccessGrant[]) => rows.filter((g) => Date.parse(g.expires_at) - now <= 7 * DAY_MS).length;
  const accessFacet = orgResult?.facets.access_level ?? [];
  const levelCount = (...levels: string[]) => accessFacet.filter((b) => levels.includes(b.value)).reduce((n, b) => n + b.count, 0);
  const auditReady = audit.settled;

  const roleLabel = platformAdmin
    ? t("enums.PlatformRole.PLATFORM_ADMIN")
    : steward
      ? t("enums.OrgRole.DATA_STEWARD")
      : orgAdmin
        ? t("enums.OrgRole.ORG_ADMIN")
        : t("dashboard.researcher");
  const activityTitle = platformAdmin ? t("dashboard.activity.portal") : staff ? t("dashboard.activity.org") : t("dashboard.activity.mine");

  const orgDatasetsTile: Tile = {
    key: "orgDatasets",
    href: `/commons/data?owner_organization_id=${orgId}`,
    label: t("dashboard.kpi.orgDatasets"),
    value: orgResult ? orgResult.total : null,
    foot: staff ? t("dashboard.kpi.orgDatasetsFoot", { open: levelCount("PUBLIC"), controlled: levelCount("CONTROLLED", "SENSITIVE") }) : t("dashboard.kpi.orgReadyFoot", { count: readinessCounts(orgResult).PASS }),
    delta: staff && auditReady ? <AddedChip count={sum(createdDaily)} /> : undefined,
    trend: staff ? (
      <Sparkline variant="line" values={cumulativeEndingAt(createdDaily, orgResult?.total ?? 0)} />
    ) : (
      <SegmentBar className="mt-3 h-1.5" parts={STATUS.map((s) => ({ key: s.key, value: readinessCounts(orgResult)[s.key], color: s.color }))} />
    ),
  };
  const downloadsTile: Tile = {
    key: "downloads",
    href: "/commons/activity",
    label: platformAdmin ? t("dashboard.kpi.downloadsAll") : staff ? t("dashboard.kpi.downloadsOrg") : t("dashboard.kpi.downloadsMine"),
    value: auditReady ? sum(downloadsDaily) : null,
    foot: t("dashboard.kpi.lastWeek", { count: weekOverWeek(downloadsDaily).current }),
    delta: auditReady ? <Delta ratio={weekOverWeek(downloadsDaily).ratio} /> : undefined,
    trend: <Sparkline values={downloadsDaily} />,
  };
  const grantsTileRows = staff ? grantRows : myGrantRows;
  const grantsHref = staff ? (orgAdmin ? "/commons/access?tab=org-grants" : "/commons/access?tab=review") : "/commons/access?tab=grants";
  const grantsTile: Tile = {
    key: "grants",
    href: grantsHref,
    label: staff ? t("dashboard.kpi.ownerGrants") : t("dashboard.kpi.grants"),
    value: (staff ? ownerGrants : myGrants).data ? grantsTileRows.length : null,
    foot: expiringCount(grantsTileRows) ? t("dashboard.kpi.expiringFoot", { count: expiringCount(grantsTileRows) }) : t("dashboard.kpi.expiringNone"),
    warn: expiringCount(grantsTileRows) > 0,
    trend: <Sparkline variant="line" values={activeGrantsLine(grantsTileRows)} />,
  };
  const projectsTile: Tile = {
    key: "projects",
    href: "/commons/projects",
    label: t("dashboard.kpi.projects"),
    value: projects.data ? projectRows.length : null,
    foot: t("dashboard.kpi.projectsFoot", { lead: projectRows.filter((p) => p.my_role === "PROJECT_OWNER").length, member: projectRows.filter((p) => p.my_role !== "PROJECT_OWNER").length }),
    trend: (
      <SegmentBar
        className="mt-3 h-1.5"
        parts={[
          { key: "lead", value: projectRows.filter((p) => p.my_role === "PROJECT_OWNER").length, color: "var(--color-accent)" },
          { key: "member", value: projectRows.filter((p) => p.my_role !== "PROJECT_OWNER").length, color: "var(--color-chart-muted)" },
        ]}
      />
    ),
  };
  const changeCount = openMine.filter((r) => r.status === "CHANGE_REQUESTED").length;
  const myRequestsTile: Tile = {
    key: "myRequests",
    href: "/commons/access?tab=requests",
    label: t("dashboard.kpi.openRequests"),
    value: mine.data ? openMine.length : null,
    foot: changeCount ? t("dashboard.kpi.changeFoot", { count: changeCount }) : t("dashboard.kpi.changeNone"),
    warn: changeCount > 0,
    trend: <Sparkline values={requestedDaily} />,
  };
  const tiles: Tile[] = staff
    ? [
        orgDatasetsTile,
        {
          key: "published",
          href: `/commons/data?owner_organization_id=${orgId}`,
          label: t("dashboard.kpi.published"),
          value: auditReady ? sum(publishedDaily) : null,
          foot: t("dashboard.kpi.publishedFoot", { count: sum(publishedDaily.slice(-7)) }),
          trend: <Sparkline values={publishedDaily} />,
        },
        steward
          ? {
              key: "pending",
              href: "/commons/access?tab=review",
              label: t("dashboard.kpi.pending"),
              value: review.data ? pendingReview.length : null,
              foot: decided.count ? t("dashboard.kpi.pendingFoot", { count: decided.count, days: (decided.meanDays ?? 0).toFixed(1) }) : t("dashboard.kpi.pendingFootNone"),
              warn: pendingReview.some((r) => daysSince(r.created_at, now) >= 3),
              trend: <Sparkline values={requestedDaily} />,
            }
          : projectsTile,
        grantsTile,
        downloadsTile,
      ]
    : [orgDatasetsTile, myRequestsTile, grantsTile, downloadsTile, projectsTile];

  // Field bars: council-wide subject facet, the institute's share emphasised.
  const fieldRows = useMemo(() => {
    const portal = portalResult?.facets.subject ?? [];
    const own = orgResult?.facets.subject ?? [];
    return portal.slice(0, 7).map((b) => ({ key: b.value, label: vocab("SUBJECT", b.value), total: b.count, mine: own.find((x) => x.value === b.value)?.count ?? 0 }));
  }, [portalResult, orgResult, vocab]);

  const queue = steward ? review : mine;
  const decidedRows = (steward ? reviewRows : mineRows)
    .filter((r) => !(steward ? PENDING : OPEN).has(r.status) && r.status !== "DRAFT")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const queueRows = steward ? pendingReview : openMine;
  const kindTotals = useMemo(() => Object.fromEntries(KINDS.map((k) => [k, sum(buckets.map((b) => b.counts[k]))])) as Record<(typeof KINDS)[number], number>, [buckets]);

  return (
    <div className={cn(entrance && "dash-enter")}>
      <ScreenTitle
        context={[orgName, roleLabel]}
        title={t("dashboard.title")}
        actions={
          <>
            <span className="num mr-1 hidden items-center gap-1.5 rounded-sm border border-border px-2 py-1 text-small text-fg-muted md:flex">
              <span className="size-1.5 rounded-full bg-success-solid" aria-hidden="true" />
              {t("dashboard.window")}
              <span className="font-mono text-mono">
                {shortDay(keys[0]!)}–{shortDay(keys.at(-1)!)}
              </span>
            </span>
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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <KpiStrip tiles={tiles} label={t("dashboard.summary")} />

        <Panel eyebrow={t("dashboard.activity.eyebrow")} title={activityTitle} count={auditReady ? t("dashboard.activity.events", { count: nf.format(inWindow.length) }) : null} href="/commons/activity" className="lg:col-span-8">
          {audit.query.isError ? (
            <Failed error={audit.query.error} retry={audit.query.refetch} />
          ) : !auditReady ? (
            <Loading />
          ) : (
            <div className="flex flex-col gap-3 px-4 pb-3 pt-3">
              <ul className="flex flex-wrap gap-x-4 gap-y-1">
                {KINDS.map((k) => (
                  <li key={k} className="flex items-center gap-1.5 text-caption font-normal text-fg-muted">
                    <span aria-hidden="true" className="inline-block size-2 rounded-[2px]" style={{ background: KIND_COLOR[k] }} />
                    {t(`dashboard.activity.kinds.${k}`)}
                    <span className="num font-mono font-medium text-fg">{kindTotals[k]}</span>
                  </li>
                ))}
              </ul>
              <ActivityChart
                buckets={buckets}
                label={t("dashboard.activity.chartLabel", { title: activityTitle })}
                kindLabel={(k) => t(`dashboard.activity.kinds.${k}`)}
                dayLabel={shortDay}
                todayLabel={t("dashboard.activity.today")}
                totalLabel={t("dashboard.activity.total")}
                dateHeader={t("dashboard.activity.date")}
                emptyOverlay={
                  <div className="rounded-sm bg-bg-panel/90 px-3 py-2 text-center">
                    <p className="text-small font-medium text-fg">{t("dashboard.activity.empty")}</p>
                    <p className="text-caption font-normal text-fg-muted">{t("dashboard.activity.emptyHint")}</p>
                  </div>
                }
              />
            </div>
          )}
        </Panel>

        <Panel eyebrow={t("dashboard.readiness.eyebrow")} title={t("dashboard.readiness.title")} href="/commons/data" className="lg:col-span-4">
          {orgSearch.isError ? (
            <Failed error={orgSearch.error} retry={orgSearch.refetch} />
          ) : !orgResult || !portalResult ? (
            <Loading />
          ) : (
            <div className="flex flex-1 flex-col justify-center gap-5 px-4 py-4">
              {orgResult.total > 0 ? (
                <ReadinessScope name={orgName} result={orgResult} emphasis />
              ) : (
                <p className="text-small text-fg-muted">{t("dashboard.readiness.emptyOrg", { org: orgName })}</p>
              )}
              <div className="border-t border-border pt-4">
                <ReadinessScope name={t("dashboard.readiness.portal")} result={portalResult} />
              </div>
            </div>
          )}
        </Panel>

        <Panel
          eyebrow={t("dashboard.queue.eyebrow")}
          title={steward ? t("dashboard.queue.review") : t("dashboard.queue.mine")}
          count={queue.data ? queueRows.length : null}
          href={steward ? "/commons/access?tab=review" : "/commons/access?tab=requests"}
          className="lg:col-span-8"
        >
          {queue.isError ? (
            <Failed error={queue.error} retry={queue.refetch} />
          ) : !queue.data ? (
            <Loading />
          ) : queueRows.length === 0 ? (
            steward ? (
              <EmptyBody title={t("dashboard.queue.emptyReview")} hint={decided.count ? t("dashboard.queue.emptyReviewDone", { count: decided.count }) : undefined} href="/commons/access?tab=review" action={t("dashboard.queue.openAction")} />
            ) : (
              <EmptyBody title={t("dashboard.queue.emptyMine")} hint={t("dashboard.queue.emptyMineHint")} href="/commons/data" action={t("dashboard.findData")} />
            )
          ) : steward ? (
            <ReviewRows rows={queueRows.slice(0, 5)} now={now} />
          ) : (
            <MyRequestRows rows={queueRows.slice(0, 5)} now={now} />
          )}
          {queue.data && decidedRows.length > 0 && queueRows.length < 4 ? <DecidedRows rows={decidedRows.slice(0, 4 - Math.min(queueRows.length, 3))} now={now} steward={steward} /> : null}
        </Panel>

        <Panel
          eyebrow={t("dashboard.grants.eyebrow")}
          title={staff ? t("dashboard.grants.titleOwner") : t("dashboard.grants.titleMine")}
          count={grantsQuery.data ? grantRows.length : null}
          href={grantsHref}
          className="lg:col-span-4"
        >
          {grantsQuery.isError ? (
            <Failed error={grantsQuery.error} retry={grantsQuery.refetch} />
          ) : !grantsQuery.data ? (
            <Loading />
          ) : grantRows.length === 0 ? (
            <EmptyBody title={t("dashboard.grants.empty")} hint={t("dashboard.grants.emptyHint")} href="/commons/data" action={t("dashboard.findData")} />
          ) : (
            <GrantRows rows={grantRows.slice(0, 5)} now={now} owner={staff} />
          )}
        </Panel>

        <Panel eyebrow={t("dashboard.health.eyebrow")} title={t("dashboard.health.title", { org: orgName })} count={orgResult ? orgResult.total : null} href={`/commons/data?owner_organization_id=${orgId}`} className="lg:col-span-8">
          {orgSearch.isError ? (
            <Failed error={orgSearch.error} retry={orgSearch.refetch} />
          ) : !orgResult ? (
            <Loading />
          ) : orgHits.length === 0 ? (
            <EmptyBody
              title={t("dashboard.health.empty", { org: orgName })}
              hint={t("dashboard.health.emptyHint")}
              href={steward ? "/commons/data/new" : "/commons/data"}
              action={steward ? t("dashboard.newDataset") : t("dashboard.findData")}
            />
          ) : (
            <HealthTable hits={orgHits.slice(0, HEALTH_ROWS)} now={now} caption={t("dashboard.health.title", { org: orgName })} />
          )}
        </Panel>

        <Panel eyebrow={t("dashboard.fields.eyebrow")} title={t("dashboard.fields.title")} href="/commons/data" className="lg:col-span-4">
          {portalSearch.isError ? (
            <Failed error={portalSearch.error} retry={portalSearch.refetch} />
          ) : !portalResult || !orgResult ? (
            <Loading />
          ) : (
            <div className="flex flex-1 flex-col justify-center px-4 py-4">
              <FieldBars rows={fieldRows} mineLabel={t("dashboard.fields.mine")} othersLabel={t("dashboard.fields.others")} />
            </div>
          )}
        </Panel>

        <Panel eyebrow={t("dashboard.feed.eyebrow")} title={t("dashboard.feed.title")} count={portalResult ? t("dashboard.feed.total", { count: portalResult.total }) : null} href="/commons/data" className="lg:col-span-8">
          {portalSearch.isError ? (
            <Failed error={portalSearch.error} retry={portalSearch.refetch} />
          ) : !portalResult ? (
            <Loading />
          ) : (
            <PortalFeed hits={flattenPages(portalSearch.data) as Hit[]} now={now} />
          )}
        </Panel>

        <Panel eyebrow={t("dashboard.recent.eyebrow")} title={t("dashboard.recent.title")} href="/commons/activity" className="lg:col-span-4">
          {audit.query.isError ? (
            <Failed error={audit.query.error} retry={audit.query.refetch} />
          ) : !audit.query.data ? (
            <Loading />
          ) : events.length === 0 ? (
            <FirstSteps />
          ) : (
            <RecentFeed events={events} now={now} />
          )}
        </Panel>
      </div>
    </div>
  );
}
