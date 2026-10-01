"use client";
import { Checkbox, DataTable, EmptyState, FormField, Input, Select, StatusBadge } from "@nais/ui";
import { useTranslations } from "next-intl";
import { ENUMS } from "@/generated/contracts";
import { useListProjects } from "@/features/projects/api";
import { flattenPages } from "@/shared/api/pagination";
import type { AuditAction, AuditEvent, Query, ResourceType } from "@/shared/api/types";
import { hasOrgRole, useMeData } from "@/shared/hooks/use-me";
import { useUrlQuery } from "@/shared/hooks/use-url-query";
import { DateTime } from "@/shared/ui/date-text";
import { PageHeader } from "@/shared/ui/page-header";
import { DelayedSkeleton, ErrorView, LoadMore } from "@/shared/ui/state-views";
import { useListAuditEvents } from "./api";

const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Start of the given Asia/Seoul calendar day as a UTC ISO instant, or null for anything that is not a real date. */
function seoulDayStart(date: string | null): number | null {
  if (!date || !DATE.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00.000+09:00`);
  return Number.isNaN(ms) ? null : ms;
}

const isAction = (v: string): v is AuditAction => (ENUMS.AuditAction as readonly string[]).includes(v);
const isResourceType = (v: string): v is ResourceType => (ENUMS.ResourceType as readonly string[]).includes(v);

/**
 * M10 §7.11. The URL is the single source of truth for the filters. Filters only narrow what the server already
 * allows the caller to see (M09 §6); nothing here widens or hides rows, so DOWNLOAD_DENIED appears iff the server sends it.
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
  const projects = useListProjects({ scope: "mine", limit: 100 });
  const projectList = flattenPages(projects.data);

  const query: Query<"listAuditEvents"> = {
    ...(actions.length ? { action: actions } : {}),
    ...(projectId ? { project_id: projectId } : {}),
    ...(resourceType ? { resource_type: resourceType } : {}),
    ...(fromMs !== null ? { from: new Date(fromMs).toISOString() } : {}),
    // The end date is inclusive for the user; the server's `to` is exclusive, so send the start of the next day.
    ...(toMs !== null ? { to: new Date(toMs + DAY_MS).toISOString() } : {}),
  };
  const q = useListAuditEvents(query);
  const rows = flattenPages(q.data);
  const scope = me.platform_roles.includes("PLATFORM_ADMIN") ? "platform" : hasOrgRole(me, "ORG_ADMIN", "DATA_STEWARD") ? "org" : "self";

  const toggleAction = (a: AuditAction) => setParams({ action: actions.includes(a) ? actions.filter((x) => x !== a) : [...actions, a] });

  return (
    <>
      <PageHeader title={t("activity.title")} description={t(`activity.scope.${scope}`)} />
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <details className="relative">
          <summary className="flex h-10 cursor-pointer items-center rounded-md border border-border px-3 text-sm">
            {t("activity.filter.actions")}
            {actions.length ? ` (${actions.length})` : ""}
          </summary>
          <fieldset className="absolute z-20 mt-1 grid max-h-80 w-72 gap-1 overflow-y-auto rounded-md border border-border bg-background p-3 shadow-lg">
            <legend className="sr-only">{t("activity.filter.actions")}</legend>
            {ENUMS.AuditAction.map((a) => (
              <label key={a} className="flex items-center gap-2 text-sm">
                <Checkbox checked={actions.includes(a)} onChange={() => toggleAction(a)} />
                {t(`enums.AuditAction.${a}`)}
              </label>
            ))}
          </fieldset>
        </details>
        <FormField id="activity-project" label={t("activity.filter.project")}>
          {(a11y) => (
            <Select {...a11y} value={projectId} onChange={(e) => setParams({ project_id: e.target.value || null })}>
              <option value="">{t("activity.filter.allProjects")}</option>
              {projectId && !projectList.some((p) => p.project_id === projectId) ? <option value={projectId}>{projectId.slice(-8)}</option> : null}
              {projectList.map((p) => (
                <option key={p.project_id} value={p.project_id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField id="activity-resource" label={t("activity.filter.resourceType")}>
          {(a11y) => (
            <Select {...a11y} value={resourceType} onChange={(e) => setParams({ resource_type: e.target.value || null })}>
              <option value="">{t("activity.filter.allResources")}</option>
              {ENUMS.ResourceType.map((r) => (
                <option key={r} value={r}>
                  {t(`enums.ResourceType.${r}`)}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField id="activity-from" label={t("activity.filter.from")}>
          {(a11y) => <Input {...a11y} type="date" value={fromMs !== null ? (fromParam ?? "") : ""} onChange={(e) => setParams({ from: e.target.value || null })} />}
        </FormField>
        <FormField id="activity-to" label={t("activity.filter.to")}>
          {(a11y) => <Input {...a11y} type="date" value={toMs !== null ? (toParam ?? "") : ""} onChange={(e) => setParams({ to: e.target.value || null })} />}
        </FormField>
      </div>
      {q.isPending ? (
        <DelayedSkeleton lines={6} />
      ) : q.isError ? (
        <ErrorView error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <p className="sr-only" aria-live="polite">
            {t("activity.count", { count: rows.length })}
          </p>
          <DataTable<AuditEvent>
            caption={t("activity.title")}
            rows={rows}
            rowKey={(e) => e.audit_event_id}
            empty={<EmptyState title={t("activity.empty")} />}
            columns={[
              { key: "time", header: t("activity.columns.time"), cell: (e) => <DateTime value={e.occurred_at} /> },
              {
                key: "actor",
                header: t("activity.columns.actor"),
                cell: (e) => (e.actor.type === "SYSTEM" ? t("activity.system") : (e.actor.display_name ?? e.actor.user_id ?? "—")),
              },
              { key: "action", header: t("activity.columns.action"), cell: (e) => t(`enums.AuditAction.${e.action}`) },
              {
                key: "target",
                header: t("activity.columns.target"),
                cell: (e) => (
                  <span>
                    {t(`enums.ResourceType.${e.resource.type}`)} <code className="text-xs">{e.resource.id.slice(-8)}</code>
                  </span>
                ),
              },
              {
                key: "result",
                header: t("activity.columns.result"),
                cell: (e) => <StatusBadge tone={e.result === "SUCCESS" ? "success" : "danger"} label={t(`activity.result.${e.result}`)} />,
              },
              { key: "reason", header: t("activity.columns.reason"), cell: (e) => (e.reason ? (t.has(`errors.${e.reason}`) ? t(`errors.${e.reason}`) : e.reason) : "—") },
              {
                key: "details",
                header: t("activity.columns.details"),
                cell: (e) => (
                  <details>
                    <summary className="cursor-pointer text-xs underline">{t("activity.showDetails")}</summary>
                    <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-xs">
                      <dt>{t("common.traceId")}</dt>
                      <dd>
                        <code className="break-all">{e.trace_id}</code>
                      </dd>
                      <dt>{t("activity.policyVersion")}</dt>
                      <dd>{e.policy_version ?? "—"}</dd>
                    </dl>
                    {e.details && Object.keys(e.details).length ? <pre className="mt-1 whitespace-pre-wrap break-all text-xs">{JSON.stringify(e.details, null, 2)}</pre> : null}
                  </details>
                ),
              },
            ]}
          />
        </>
      )}
      <LoadMore hasNextPage={q.hasNextPage} isFetchingNextPage={q.isFetchingNextPage} fetchNextPage={q.fetchNextPage} />
    </>
  );
}
