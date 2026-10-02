"use client";
import { Badge, Button, ConfirmDialog, Menu, Tabs, TabsContent, TabsList, TabsTrigger, Tag, buttonClass } from "@nais/ui";
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
import { ProjectStatusBadge } from "@/shared/ui/badges";
import { DateTime } from "@/shared/ui/date-text";
import { PageHeader } from "@/shared/ui/page-header";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { notify } from "@/shared/ui/toast";
import { useArchiveProject, useGetProject, useListProjectMembers, useListProjects, useUpdateProject } from "./api";
import { MembersTab } from "./components/members-tab";
import { ProjectDataTab } from "./components/project-data-tab";
import { ProjectForm } from "./components/project-form";
import { ProjectRoleBadge } from "./components/project-role-badge";
import { fromProject, toProjectUpdate } from "./schemas";
import { useBreadcrumbs } from "@/shared/ui/breadcrumbs";

const TABS = ["overview", "members", "data", "activity"] as const;
type Tab = (typeof TABS)[number];
const ROLE_ORDER: ProjectRole[] = ["PROJECT_OWNER", "PROJECT_ADMIN", "RESEARCHER", "VIEWER"];

/** Right-rail panel (detail template): caption title + definition list, 1px border. */
function RailPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-md border border-border bg-bg-panel p-4">
      <h2 className="mb-3 text-caption text-fg-muted">{title}</h2>
      {children}
    </section>
  );
}

function Period({ project }: { project: Pick<Project, "start_date" | "end_date"> }) {
  if (!project.start_date && !project.end_date) return <span className="text-fg-muted">—</span>;
  return (
    <span className="num">
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
      <PageHeader title={p?.name ?? t("projects.detail.title")} badges={p ? <Badge>{t(`enums.ProjectVisibility.${p.visibility}`)}</Badge> : null} />
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <p role="alert" className="flex items-start gap-3 self-start rounded-md border border-info-line bg-info-soft p-4 text-body text-fg">
          <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-info" strokeWidth={1.75} />
          {t("projects.detail.membersOnly")}
        </p>
        {p ? (
          <RailPanel title={t("projects.detail.info")}>
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
        <h2 id="project-about" className="mb-2 text-heading text-fg">
          {t("projects.detail.about")}
        </h2>
        {project.description ? (
          <p className="max-w-[72ch] whitespace-pre-wrap break-keep text-[15px] leading-[26px] text-fg">{project.description}</p>
        ) : (
          <p className="text-small text-fg-muted">{t("projects.detail.noDescription")}</p>
        )}
      </section>
      <section aria-labelledby="project-keywords">
        <h2 id="project-keywords" className="mb-2 text-heading text-fg">
          {t("projects.form.keywords")}
        </h2>
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
      <RailPanel title={t("projects.detail.info")}>
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
      <RailPanel title={t("projects.detail.roleSplit")}>
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
                <span className="num text-right text-fg">{n}</span>
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
      <PageHeader
        title={p.name}
        meta={
          <>
            {lead?.name ? <span>{t("projects.detail.leadBy", { org: lead.name })}</span> : null}
            <span className="num">{t("projects.detail.orgCount", { count: p.organizations.length })}</span>
            <span className="num">
              {t("projects.detail.updatedAt")} <DateTime value={p.updated_at ?? p.created_at} dateOnly />
            </span>
          </>
        }
        badges={
          <>
            <ProjectStatusBadge status={p.status} />
            <Badge>{t(`enums.ProjectVisibility.${p.visibility}`)}</Badge>
            {p.my_role ? <ProjectRoleBadge role={p.my_role} /> : null}
          </>
        }
        actions={
          manager || canArchive ? (
            <>
              {manager ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setEditing(true);
                    setParams({ tab: null });
                  }}
                >
                  <Pencil aria-hidden="true" />
                  {t("common.edit")}
                </Button>
              ) : null}
              {canArchive ? (
                <Menu.Root>
                  <Menu.Trigger aria-label={t("projects.detail.more")} className={buttonClass("secondary", "md", "w-8 px-0")}>
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
