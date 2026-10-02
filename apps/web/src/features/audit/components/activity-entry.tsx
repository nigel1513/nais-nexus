"use client";
import { Avatar, cn, PathText, StatusBadge } from "@nais/ui";
import { Bot, ChevronDown } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";
import { useSearchDatasets } from "@/features/catalog/api";
import { useOrgNames } from "@/features/organizations/api";
import { useListProjects } from "@/features/projects/api";
import { flattenPages } from "@/shared/api/pagination";
import type { AuditEvent } from "@/shared/api/types";
import { formatDate, formatDateTime } from "@/shared/lib/format";

/** Names the timeline can show instead of IDs: what the caller can already see (their projects, the datasets search). */
export type TargetNames = { projects: Record<string, string>; datasets: Record<string, string>; orgs: Record<string, string> };

export function useTargetNames(): TargetNames {
  const projects = useListProjects({ scope: "mine", limit: 100 });
  const datasets = useSearchDatasets({ limit: 100 });
  const orgs = useOrgNames();
  return useMemo(
    () => ({
      projects: Object.fromEntries(flattenPages(projects.data).map((p) => [p.project_id, p.name])),
      datasets: Object.fromEntries(flattenPages(datasets.data).map((d) => [d.dataset_id, d.title])),
      orgs,
    }),
    [projects.data, datasets.data, orgs],
  );
}

export type Target = { kind: string; name?: string; id: string; href?: string };

/** Where an event's resource lives in the app, if anywhere the caller can open. */
export function targetOf(e: AuditEvent, names: TargetNames): Target {
  const { type, id } = e.resource;
  switch (type) {
    case "PROJECT":
      return { kind: type, id, name: names.projects[id], href: `/commons/projects/${id}` };
    case "PROJECT_MEMBER":
      return e.project_id ? { kind: type, id, name: names.projects[e.project_id], href: `/commons/projects/${e.project_id}` } : { kind: type, id };
    case "DATASET":
      return { kind: type, id, name: names.datasets[id], href: `/commons/data/${id}` };
    case "ACCESS_REQUEST":
      return { kind: type, id, href: `/commons/access/${id}` };
    case "ACCESS_GRANT":
      return { kind: type, id, href: "/commons/access?tab=grants" };
    case "ORGANIZATION":
      return { kind: type, id, name: names.orgs[id] };
    default:
      return { kind: type, id };
  }
}

/** Seoul calendar day "YYYY-MM-DD" of an event, used to group the timeline. */
export const eventDay = (e: AuditEvent) => formatDate(e.occurred_at);

export function actorName(e: AuditEvent, systemLabel: string): string {
  return e.actor.type === "SYSTEM" ? systemLabel : (e.actor.display_name ?? e.actor.user_id ?? "—");
}

/** Words a search box can match: actor, verb, target kind / name / id. */
export function searchText(e: AuditEvent, names: TargetNames, t: ReturnType<typeof useTranslations>): string {
  const target = targetOf(e, names);
  return [actorName(e, t("activity.system")), t(`activity.verb.${e.action}`), t(`enums.ResourceType.${e.resource.type}`), target.name ?? "", e.resource.id]
    .join(" ")
    .toLowerCase();
}

/** Reason text: a known error code is localized; anything else (a reviewer's reason or comment) is shown as written. */
function useReasonText() {
  const t = useTranslations();
  return (reason: string) => (t.has(`errors.${reason}`) ? t(`errors.${reason}`) : reason);
}

function ActorChip({ e, names }: { e: AuditEvent; names: TargetNames }) {
  const t = useTranslations();
  const actor = actorName(e, t("activity.system"));
  const org = e.actor.organization_id ? names.orgs[e.actor.organization_id] : undefined;
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      {e.actor.type === "SYSTEM" ? (
        <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center rounded-full bg-bg-active text-fg-muted">
          <Bot className="size-3" strokeWidth={1.75} />
        </span>
      ) : (
        <Avatar name={actor} size={20} decorative />
      )}
      <span className="font-medium text-fg">{actor}</span>
      {org ? <span className="text-small text-fg-muted">{org}</span> : null}
    </span>
  );
}

function Time({ iso, full }: { iso: string; full?: boolean }) {
  return (
    <time dateTime={iso} title={new Date(iso).toISOString()} className={cn("num font-mono text-mono text-fg-muted", full ? "" : "leading-6")}>
      {full ? formatDateTime(iso) : formatDateTime(iso).slice(11)}
    </time>
  );
}

/** 24px disclosure in its own grid column, aligned with the entry's first line. */
function Disclosure({ open, onToggle, controls, label }: { open: boolean; onToggle: () => void; controls: string; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className="inline-flex size-6 cursor-pointer items-center justify-center self-start rounded-sm text-fg-subtle outline-none hover:bg-bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-focus aria-expanded:text-fg"
    >
      <ChevronDown aria-hidden="true" className={cn("size-4", open && "rotate-180")} strokeWidth={1.75} />
    </button>
  );
}

const rowGrid = (compact: boolean) => cn("grid gap-x-3 border-b border-border py-2", compact ? "grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-[3rem_minmax(0,1fr)_auto]");

/**
 * One audit event: Seoul time (mono, tabular), actor avatar + name + organization, a verb phrase, the target as a link
 * when the app has a page for it, the result when it was denied, any recorded reason (a rejection reason, a change
 * request comment, a denial code) and the trace on demand. `inRun` drops actor and verb (the run's row says them).
 */
export function ActivityEntry({ event: e, names, compact = false, inRun = false }: { event: AuditEvent; names: TargetNames; compact?: boolean; inRun?: boolean }) {
  const t = useTranslations();
  const reasonText = useReasonText();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const target = targetOf(e, names);
  const denied = e.result !== "SUCCESS";
  const label = target.name ?? null;
  const details = Object.entries(e.details ?? {});

  const targetText = (
    <>
      <span className="text-fg-muted">{t(`enums.ResourceType.${target.kind}`)}</span>{" "}
      {label ? <span className="font-medium">{label}</span> : <code className="font-mono text-mono">{target.id.slice(-8)}</code>}
    </>
  );

  return (
    <div className={cn(rowGrid(compact), inRun && "border-b-0 py-1")}>
      {compact ? null : <Time iso={e.occurred_at} />}
      <div className="min-w-0">
        <div className="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1 text-body">
          {inRun ? null : (
            <>
              <ActorChip e={e} names={names} />
              <span className="text-fg">{t(`activity.verb.${e.action}`)}</span>
            </>
          )}
          {target.href ? (
            <Link href={target.href} className="min-w-0 truncate text-fg underline decoration-border-strong underline-offset-4 hover:decoration-fg">
              {targetText}
            </Link>
          ) : (
            <span className="min-w-0 truncate text-fg">{targetText}</span>
          )}
          {denied ? <StatusBadge tone="danger" label={t(`activity.result.${e.result}`)} /> : null}
          {compact ? (
            <span className="text-small">
              <Time iso={e.occurred_at} full />
            </span>
          ) : null}
        </div>
        {/* Plain text only: a reviewer's reason or comment is user input (M10 §16). */}
        {e.reason ? (
          <p className={cn("mt-1 whitespace-pre-wrap break-words text-small", denied ? "text-danger" : "text-fg-muted")}>
            <span className="font-medium">{t("activity.reason")}</span> · {reasonText(e.reason)}
          </p>
        ) : null}
        {open ? (
          <dl id={detailsId} className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-md border border-border bg-bg-subtle px-3 py-2 text-small">
            {e.reason ? (
              <>
                <dt className="text-fg-muted">{t("activity.reason")}</dt>
                <dd className="whitespace-pre-wrap break-words text-fg">{reasonText(e.reason)}</dd>
              </>
            ) : null}
            <dt className="text-fg-muted">{t("common.traceId")}</dt>
            <dd className="min-w-0">
              <PathText value={e.trace_id} copyLabel={t("common.copyTraceId")} copiedLabel={t("common.copied")} />
            </dd>
            <dt className="text-fg-muted">{t("activity.policyVersion")}</dt>
            <dd className="font-mono text-mono text-fg">{e.policy_version ?? "—"}</dd>
            {details.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="font-mono text-mono text-fg-muted">{k}</dt>
                <dd className="break-all font-mono text-mono text-fg">{typeof v === "string" ? v : JSON.stringify(v)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
      <Disclosure open={open} onToggle={() => setOpen((o) => !o)} controls={detailsId} label={t("activity.showDetails")} />
    </div>
  );
}

/** Same actor, action and result back to back: one entry, so twelve validations read as one line. */
export const sameRun = (a: AuditEvent, b: AuditEvent) =>
  a.action === b.action && a.result === b.result && a.actor.type === b.actor.type && (a.actor.user_id ?? null) === (b.actor.user_id ?? null);

/** A collapsed run of identical consecutive events; expands to the individual targets (newest first). */
export function ActivityRun({ events, names, compact = false }: { events: AuditEvent[]; names: TargetNames; compact?: boolean }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const first = events[0]!;
  const last = events.at(-1)!;
  return (
    <div className={rowGrid(compact)}>
      {compact ? null : <Time iso={first.occurred_at} />}
      <div className="min-w-0">
        <div className="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1 text-body">
          <ActorChip e={first} names={names} />
          <span className="text-fg">{t(`activity.verbMany.${first.action}`, { count: events.length })}</span>
          {first.result !== "SUCCESS" ? <StatusBadge tone="danger" label={t(`activity.result.${first.result}`)} /> : null}
          {/* The span of the run, only when it is longer than the minute the time column already shows. */}
          {formatDateTime(last.occurred_at) !== formatDateTime(first.occurred_at) ? (
            <span className="num text-small text-fg-muted">
              {formatDateTime(last.occurred_at).slice(11)}–{formatDateTime(first.occurred_at).slice(11)}
            </span>
          ) : null}
        </div>
        {open ? (
          <ol id={listId} className="mt-1 border-l border-border pl-3">
            {events.map((e) => (
              <li key={e.audit_event_id}>
                <ActivityEntry event={e} names={names} compact inRun />
              </li>
            ))}
          </ol>
        ) : null}
      </div>
      <Disclosure open={open} onToggle={() => setOpen((o) => !o)} controls={listId} label={t("activity.expandRun", { count: events.length })} />
    </div>
  );
}
