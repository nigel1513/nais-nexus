"use client";
import { Badge, Tag } from "@nais/ui";
import { Globe, Lock, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useOrgNames } from "@/features/organizations/api";
import { useListProjectMembers, useListProjects, useUpdateProject } from "@/features/projects/api";
import { ProjectForm } from "@/features/projects/components/project-form";
import { fromProject, toProjectUpdate } from "@/features/projects/schemas";
import { flattenPages } from "@/shared/api/pagination";
import type { Project, ProjectRole } from "@/shared/api/types";
import { AccessLevelBadge, OutputPublishBadge } from "@/shared/ui/badges";
import { DateTime } from "@/shared/ui/date-text";
import { Crumb, ScreenTitle } from "@/shared/ui/screen-v2";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { notify } from "@/shared/ui/toast";
import { PanelHead } from "@/shared/ui/work-hero";
import { useOutputs, useProjectInputs } from "./api";
import { RunsList } from "./runs-list";
import { projectHref, useWorkspace } from "./workspace-layout";

const ROLE_ORDER: ProjectRole[] = ["PROJECT_OWNER", "PROJECT_ADMIN", "RESEARCHER", "VIEWER"];
const linkClass = "font-medium text-fg underline-offset-4 hover:underline";

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

/** A PUBLIC project seen by a non-member: the members-only notice and the public summary. */
export function PublicSummary({ projectId }: { projectId: string }) {
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

function About({ project }: { project: Project }) {
  const t = useTranslations();
  return (
    <>
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
    </>
  );
}

function InputsSummary({ projectId }: { projectId: string }) {
  const t = useTranslations();
  const inputs = useProjectInputs(projectId);
  const rows = inputs.data?.items ?? [];
  const lapsed = rows.filter((i) => i.access_lapsed).length;
  return (
    <section aria-labelledby="ws-inputs">
      <PanelHead
        id="ws-inputs"
        crumb={t("workspace.tabs.data")}
        title={t("workspace.inputs.title")}
        count={inputs.data ? rows.length : undefined}
        more={{ href: projectHref(projectId, "data"), label: t("workspace.overview.all") }}
        className="mb-3"
      />
      {inputs.isPending ? (
        <DelayedSkeleton lines={2} />
      ) : inputs.isError ? (
        <ErrorView error={inputs.error} onRetry={() => void inputs.refetch()} />
      ) : rows.length ? (
        <>
          {lapsed ? (
            <p role="status" className="mb-2 flex items-center gap-2 text-small text-fg">
              <TriangleAlert aria-hidden="true" strokeWidth={1.75} className="size-4 shrink-0 text-warning" />
              {t("workspace.overview.lapsed", { count: lapsed })}
            </p>
          ) : null}
          <ul className="flex flex-col divide-y divide-border border-y border-border">
            {rows.map((i) => (
              <li key={i.input_id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-small">
                <Link href={`/commons/data/${i.dataset_id}`} className={`${linkClass} min-w-0 truncate`}>
                  {i.dataset_title}
                </Link>
                <span className="num font-mono text-mono text-fg-muted">{i.version_label}</span>
                <AccessLevelBadge level={i.access_level} />
                {i.access_lapsed ? <Badge tone="danger">{t("workspace.inputs.lapsed")}</Badge> : null}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-small text-fg-muted">{t("workspace.overview.noInputs")}</p>
      )}
    </section>
  );
}

function OutputsSummary({ projectId }: { projectId: string }) {
  const t = useTranslations();
  const outputs = useOutputs(projectId);
  const rows = flattenPages(outputs.data).slice(0, 5);
  return (
    <section aria-labelledby="ws-outputs">
      <PanelHead id="ws-outputs" crumb={t("workspace.tabs.outputs")} title={t("workspace.overview.recentOutputs")} more={{ href: projectHref(projectId, "outputs"), label: t("workspace.overview.all") }} className="mb-3" />
      {outputs.isPending ? (
        <DelayedSkeleton lines={2} />
      ) : outputs.isError ? (
        <ErrorView error={outputs.error} onRetry={() => void outputs.refetch()} />
      ) : rows.length ? (
        <ul className="flex flex-col divide-y divide-border border-y border-border">
          {rows.map((o) => (
            <li key={o.output_id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-small">
              <Link href={`${projectHref(projectId, "outputs")}/${o.output_id}`} className={`${linkClass} min-w-0 truncate`}>
                {o.title}
              </Link>
              <span className="text-fg-muted">{t(`enums.OutputKind.${o.kind}`)}</span>
              {o.publish_status !== "NONE" ? <OutputPublishBadge status={o.publish_status} /> : null}
              <span className="num ml-auto text-fg-muted">
                <DateTime value={o.created_at} dateOnly />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-small text-fg-muted">{t("workspace.outputs.empty")}</p>
      )}
    </section>
  );
}

/** 개요: what the project is (about, keywords) and where its work stands (inputs, recent runs, outputs). `?edit=1` edits. */
export function OverviewTab() {
  const t = useTranslations();
  const { project, manager, owner } = useWorkspace();
  const params = useSearchParams();
  const router = useRouter();
  const update = useUpdateProject(project.project_id);
  const editing = manager && params.get("edit") === "1";
  const done = () => router.replace(projectHref(project.project_id), { scroll: false });

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="flex min-w-0 flex-col gap-8">
        {editing ? (
          <ProjectForm
            defaultValues={fromProject(project)}
            visibilityLocked={!owner}
            submitLabel={t("common.save")}
            onCancel={done}
            onSubmit={async (values) => {
              const body = toProjectUpdate(values);
              // Only the OWNER may change visibility (M02): never send it for an ADMIN.
              if (!owner) delete body.visibility;
              await update.mutateAsync(body);
              notify.success(t("projects.detail.saved"));
              done();
            }}
          />
        ) : (
          <>
            <About project={project} />
            <InputsSummary projectId={project.project_id} />
            <section aria-labelledby="ws-runs">
              <PanelHead id="ws-runs" crumb={t("workspace.tabs.recipes")} title={t("workspace.overview.recentRuns")} more={{ href: projectHref(project.project_id, "recipes"), label: t("workspace.overview.all") }} className="mb-3" />
              <RunsList projectId={project.project_id} limit={5} caption={t("workspace.overview.recentRuns")} />
            </section>
            <OutputsSummary projectId={project.project_id} />
          </>
        )}
      </div>
      <ProjectRail project={project} />
    </div>
  );
}
