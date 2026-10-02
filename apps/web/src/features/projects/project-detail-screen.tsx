"use client";
import { Badge, ConfirmDialog, Menu, Tabs, TabsContent, TabsList, TabsTrigger, Tag, cn, focusRing } from "@nais/ui";
import { Archive, Ellipsis, Globe, Lock, Pencil } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import { useListAuditEvents } from "@/features/audit/api";
import { AuditTimeline } from "@/features/audit/components/audit-timeline";
import { useOrgNames } from "@/features/organizations/api";
import { asApiError } from "@/shared/api/errors";
import { flattenPages } from "@/shared/api/pagination";
import { useErrorText } from "@/shared/api/use-error-text";
import type { Project, ProjectRole } from "@/shared/api/types";
import { useUrlQuery } from "@/shared/hooks/use-url-query";
import { DateTime } from "@/shared/ui/date-text";
import { BandTag, Crumb, ScreenTitle, SummaryBand } from "@/shared/ui/screen-v2";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { notify } from "@/shared/ui/toast";
import { useArchiveProject, useGetProject, useListProjectMembers, useListProjects, useUpdateProject } from "./api";
import { MembersTab } from "./components/members-tab";
import { ProjectDataTab } from "./components/project-data-tab";
import { ProjectForm } from "./components/project-form";
import { fromProject, toProjectUpdate } from "./schemas";
import { useBreadcrumbs } from "@/shared/ui/breadcrumbs";

const TABS = ["overview", "members", "data", "activity"] as const;
type Tab = (typeof TABS)[number];
const ROLE_ORDER: ProjectRole[] = ["PROJECT_OWNER", "PROJECT_ADMIN", "RESEARCHER", "VIEWER"];

/** Right-rail panel (detail template): crumb label (accent eyebrow + title) over its content, 1px border. */
function RailPanel({ kicker, title, children }: { kicker?: string; title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-md border border-border bg-bg-panel p-4">
      <Crumb kicker={kicker} title={title} className="mb-3 [&_h2]:text-[15px]" />
      {children}
    </section>
  );
}

function Period({ project }: { project: Pick<Project, "start_date" | "end_date"> }) {
  if (!project.start_date && !project.end_date) return <span className="text-fg-muted">—</span>;
  return (
    <span className="num font-mono text-mono">
      {project.start_date ?? "…"} – {project.end_date ?? "…"}
    </span>
  );
}

function PublicSummary({ projectId }: { projectId: string }) {
  const t = useTranslations();
  const orgNames = useOrgNames();
  const discover = useListProjects({ scope: "discover", limit: 100 });
  const p = flattenPages(discover.data).find((x) => x.project_id === projectId);
  return (
    <>
      <ScreenTitle context={[t("projects.detail.context"), p ? t(`enums.ProjectVisibility.${p.visibility}`) : null]} title={p?.name ?? t("projects.detail.title")} />
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <p role="alert" className="flex items-start gap-3 self-start rounded-md border border-info-line bg-info-soft p-4 text-body text-fg">
          <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-info" strokeWidth={1.75} />
          {t("projects.detail.membersOnly")}
        </p>
        {p ? (
          <RailPanel kicker={t("projects.detail.kicker.info")} title={t("projects.detail.info")}>
            <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-small">
              <dt className="text-fg-muted">{t("projects.list.lead")}</dt>
              <dd>{orgNames[p.lead_organization_id] ?? "—"}</dd>
              <dt className="text-fg-muted">{t("projects.list.members")}</dt>
              <dd className="num">{p.member_count ?? "—"}</dd>
              <dt className="text-fg-muted">{t("projects.list.updated")}</dt>
              <dd className="num">
                <DateTime value={p.updated_at} dateOnly />
              </dd>
            </dl>
          </RailPanel>
        ) : null}
      </div>
    </>
  );
}

function Overview({ project, editing, onEditDone, canArchive }: { project: Project; editing: boolean; onEditDone: () => void; canArchive: boolean }) {
  const t = useTranslations();
  const update = useUpdateProject(project.project_id);
  if (editing) {
    return (
      <ProjectForm
        defaultValues={fromProject(project)}
        visibilityLocked={!canArchive}
        submitLabel={t("common.save")}
        onCancel={onEditDone}
        onSubmit={async (values) => {
          const body = toProjectUpdate(values);
          // Only the OWNER may change visibility (M02): never send it for an ADMIN.
          if (!canArchive) delete body.visibility;
          await update.mutateAsync(body);
          notify.success(t("projects.detail.saved"));
          onEditDone();
        }}
      />
    );
  }
  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="project-about">
        <Crumb id="project-about" kicker={t("projects.detail.kicker.about")} title={t("projects.detail.about")} className="mb-3" />
        {project.description ? (
          <p className="max-w-[72ch] whitespace-pre-wrap break-keep text-[15px] leading-[26px] text-fg">{project.description}</p>
        ) : (
          <p className="text-small text-fg-muted">{t("projects.detail.noDescription")}</p>
        )}
      </section>
      <section aria-labelledby="project-keywords">
        <Crumb id="project-keywords" kicker={t("projects.detail.kicker.keywords")} title={t("projects.form.keywords")} count={project.keywords?.length || undefined} className="mb-3" />
        {project.keywords?.length ? (
          <ul className="flex flex-wrap gap-1.5">
            {project.keywords.map((k) => (
              <li key={k}>
                <Tag>{k}</Tag>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-small text-fg-muted">{t("projects.detail.noKeywords")}</p>
        )}
      </section>
    </div>
  );
}

/** Right rail: organizations, period, visibility, created date, and how the members split by role. */
function ProjectRail({ project }: { project: Project }) {
  const t = useTranslations();
  const members = useListProjectMembers(project.project_id);
  const items = members.data?.items ?? [];
  const counts = ROLE_ORDER.map((r) => [r, items.filter((m) => m.role === r).length] as const);
  const max = Math.max(1, ...counts.map(([, n]) => n));
  return (
    <aside className="flex flex-col gap-4">
      <RailPanel kicker={t("projects.detail.kicker.info")} title={t("projects.detail.info")}>
        <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-small">
          <dt className="text-fg-muted">{t("projects.detail.organizations")}</dt>
          <dd>
            <ul className="flex flex-col gap-1">
              {project.organizations.map((o) => (
                <li key={o.organization_id} className="flex items-center justify-between gap-2">
                  <span className="truncate">{o.name ?? o.organization_id}</span>
                  <Badge tone={o.role === "LEAD" ? "accent" : "neutral"}>{t(`projects.detail.orgRole.${o.role}`)}</Badge>
                </li>
              ))}
            </ul>
          </dd>
          <dt className="text-fg-muted">{t("projects.detail.period")}</dt>
          <dd>
            <Period project={project} />
          </dd>
          <dt className="text-fg-muted">{t("projects.form.visibility")}</dt>
          <dd className="flex items-center gap-1.5">
            {project.visibility === "PUBLIC" ? (
              <Globe aria-hidden="true" className="size-3.5 text-fg-muted" strokeWidth={1.75} />
            ) : (
              <Lock aria-hidden="true" className="size-3.5 text-fg-muted" strokeWidth={1.75} />
            )}
            {t(`enums.ProjectVisibility.${project.visibility}`)}
          </dd>
          <dt className="text-fg-muted">{t("projects.detail.createdAt")}</dt>
          <dd className="num">
            <DateTime value={project.created_at} dateOnly />
          </dd>
        </dl>
      </RailPanel>
      <RailPanel kicker={t("projects.detail.kicker.roles")} title={t("projects.detail.roleSplit")}>
        {members.isPending ? (
          <p className="text-small text-fg-muted">{t("common.loading")}</p>
        ) : (
          <ul className="flex flex-col gap-2 text-small">
            {counts.map(([role, n]) => (
              <li key={role} className="grid grid-cols-[4.5rem_minmax(0,1fr)_1.5rem] items-center gap-2">
                <span className="text-fg-muted">{t(`enums.ProjectRole.${role}`)}</span>
                <span aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-bg-hover">
                  <span className="block h-full rounded-full bg-chart-1" style={{ width: `${(n / max) * 100}%` }} />
                </span>
                <span className="text-right font-mono text-mono tabular-nums text-fg">{n}</span>
              </li>
            ))}
          </ul>
        )}
      </RailPanel>
    </aside>
  );
}

export function ProjectDetailScreen({ projectId }: { projectId: string }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const q = useGetProject(projectId);
  useBreadcrumbs(q.data ? [{ label: q.data.name }] : []);
  const [params, setParams] = useUrlQuery();
  const requested = params.get("tab");
  const tab: Tab = TABS.includes(requested as Tab) ? (requested as Tab) : "overview";
  const activity = useListAuditEvents({ project_id: projectId }, { enabled: tab === "activity" });
  const archive = useArchiveProject(projectId);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  if (q.isPending) return <DelayedSkeleton lines={5} />;
  if (q.isError) {
    if (asApiError(q.error).code === "FORBIDDEN") return <PublicSummary projectId={projectId} />;
    return <ErrorView error={q.error} onRetry={() => void q.refetch()} />;
  }
  const p = q.data;
  const archived = p.status === "ARCHIVED";
  const manager = (p.my_role === "PROJECT_OWNER" || p.my_role === "PROJECT_ADMIN") && !archived;
  const canArchive = p.my_role === "PROJECT_OWNER" && !archived;
  const lead = p.organizations.find((o) => o.role === "LEAD");

  return (
    <>
      <SummaryBand
        label={t("projects.detail.summary")}
        context={[t("projects.detail.context"), lead?.name ? t("projects.detail.leadBy", { org: lead.name }) : null]}
        title={p.name}
        tags={
          <>
            <BandTag tone={archived ? "warn" : "ok"}>{t(`enums.ProjectStatus.${p.status}`)}</BandTag>
            <BandTag icon={p.visibility === "PUBLIC" ? <Globe aria-hidden="true" strokeWidth={1.75} /> : <Lock aria-hidden="true" strokeWidth={1.75} />}>
              {t(`enums.ProjectVisibility.${p.visibility}`)}
            </BandTag>
            {p.my_role ? <BandTag tone="accent">{t("projects.detail.myRole", { role: t(`enums.ProjectRole.${p.my_role}`) })}</BandTag> : null}
          </>
        }
        actions={
          manager || canArchive ? (
            <>
              {manager ? (
                <button
                  type="button"
                  className={cn("sv-hb sv-hb-w", focusRing)}
                  onClick={() => {
                    setEditing(true);
                    setParams({ tab: null });
                  }}
                >
                  <Pencil aria-hidden="true" strokeWidth={1.75} />
                  {t("common.edit")}
                </button>
              ) : null}
              {canArchive ? (
                <Menu.Root>
                  <Menu.Trigger aria-label={t("projects.detail.more")} className={cn("sv-hb sv-hb-g sv-hb-i", focusRing)}>
                    <Ellipsis aria-hidden="true" strokeWidth={1.75} />
                  </Menu.Trigger>
                  <Menu.Content align="end">
                    <Menu.Item tone="danger" icon={<Archive aria-hidden="true" />} onClick={() => setConfirming(true)}>
                      {t("projects.detail.archiveEllipsis")}
                    </Menu.Item>
                  </Menu.Content>
                </Menu.Root>
              ) : null}
            </>
          ) : null
        }
        facts={[
          { label: t("projects.detail.factMembers"), value: p.member_count ?? "—", unit: p.member_count !== undefined ? t("projects.detail.unitPeople") : undefined },
          { label: t("projects.detail.factOrgs"), value: p.organizations.length, unit: t("projects.detail.unitOrgs") },
          {
            label: t("projects.detail.period"),
            kind: p.start_date || p.end_date ? "mono" : "text",
            value: p.start_date || p.end_date ? `${p.start_date ?? "…"} – ${p.end_date ?? "…"}` : t("projects.detail.noPeriod"),
          },
          { label: t("projects.detail.updatedAt"), kind: "mono", value: <DateTime value={p.updated_at ?? p.created_at} dateOnly /> },
        ]}
      />
      {archived ? (
        <p role="status" className="mb-6 flex items-center gap-2 rounded-md border border-warning-line bg-warning-soft px-3 py-2 text-small text-fg">
          <Archive aria-hidden="true" className="size-4 shrink-0 text-warning" strokeWidth={1.75} />
          {t("projects.detail.archivedBanner")}
        </p>
      ) : null}
      <Tabs
        value={tab}
        onValueChange={(v) => {
          setParams({ tab: v === "overview" ? null : v });
        }}
      >
        <TabsList aria-label={t("projects.detail.tabsLabel")}>
          {TABS.map((k) => (
            <TabsTrigger key={k} value={k} count={k === "members" ? p.member_count : undefined}>
              {t(`projects.detail.tabs.${k}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0">
            <TabsContent value="overview" className="pt-0">
              <Overview project={p} editing={editing && manager} onEditDone={() => setEditing(false)} canArchive={canArchive} />
            </TabsContent>
            <TabsContent value="members" className="pt-0">
              <MembersTab project={p} manager={manager} />
            </TabsContent>
            <TabsContent value="data" className="pt-0">
              <ProjectDataTab projectId={projectId} />
            </TabsContent>
            <TabsContent value="activity" className="pt-0">
              <AuditTimeline query={activity} />
            </TabsContent>
          </div>
          <ProjectRail project={p} />
        </div>
      </Tabs>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("projects.detail.archiveTitle")}
        description={t("projects.detail.archiveWarning")}
        confirmLabel={t("projects.detail.archive")}
        cancelLabel={t("common.cancel")}
        closeLabel={t("common.close")}
        destructive
        pending={archive.isPending}
        onConfirm={() =>
          archive.mutate(undefined, {
            onSuccess: () => {
              setConfirming(false);
              notify.success(t("projects.detail.archived"));
            },
            onError: (e) => {
              setConfirming(false);
              notify.error(errorText(e));
            },
          })
        }
      />
    </>
  );
}
