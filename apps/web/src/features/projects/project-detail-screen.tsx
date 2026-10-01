"use client";
import { Badge, Button, ConfirmDialog, Tabs, TabsContent, TabsList, TabsTrigger } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useListAuditEvents } from "@/features/audit/api";
import { AuditTimeline } from "@/features/audit/components/audit-timeline";
import { useOrgNames } from "@/features/organizations/api";
import { asApiError } from "@/shared/api/errors";
import { flattenPages } from "@/shared/api/pagination";
import { useErrorText } from "@/shared/api/use-error-text";
import type { Project } from "@/shared/api/types";
import { useUrlQuery } from "@/shared/hooks/use-url-query";
import { ProjectStatusBadge } from "@/shared/ui/badges";
import { DateTime } from "@/shared/ui/date-text";
import { PageHeader } from "@/shared/ui/page-header";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { useToast } from "@/shared/ui/toast";
import { useArchiveProject, useGetProject, useListProjects, useUpdateProject } from "./api";
import { MembersTab } from "./components/members-tab";
import { ProjectDataTab } from "./components/project-data-tab";
import { ProjectForm } from "./components/project-form";
import { fromProject, toProjectUpdate } from "./schemas";

const TABS = ["overview", "members", "data", "activity"] as const;
type Tab = (typeof TABS)[number];

function PublicSummary({ projectId }: { projectId: string }) {
  const t = useTranslations();
  const orgNames = useOrgNames();
  const discover = useListProjects({ scope: "discover", limit: 100 });
  const p = flattenPages(discover.data).find((x) => x.project_id === projectId);
  return (
    <>
      <PageHeader title={p?.name ?? t("projects.detail.title")} />
      <p role="alert" className="mb-4 rounded-md border border-warning p-4">
        {t("projects.detail.membersOnly")}
      </p>
      {p ? (
        <dl className="grid max-w-md grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t("projects.list.lead")}</dt>
          <dd>{orgNames[p.lead_organization_id] ?? "—"}</dd>
          <dt className="text-muted-foreground">{t("projects.list.members")}</dt>
          <dd>{p.member_count ?? "—"}</dd>
          <dt className="text-muted-foreground">{t("projects.list.updated")}</dt>
          <dd>
            <DateTime value={p.updated_at} dateOnly />
          </dd>
        </dl>
      ) : null}
    </>
  );
}

function Overview({ project, canEdit, canArchive }: { project: Project; canEdit: boolean; canArchive: boolean }) {
  const t = useTranslations();
  const toast = useToast();
  const errorText = useErrorText();
  const update = useUpdateProject(project.project_id);
  const archive = useArchiveProject(project.project_id);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  if (editing) {
    return (
      <ProjectForm
        defaultValues={fromProject(project)}
        visibilityLocked={!canArchive}
        submitLabel={t("common.save")}
        onCancel={() => setEditing(false)}
        onSubmit={async (values) => {
          const body = toProjectUpdate(values);
          // Only the OWNER may change visibility (M02): never send it for an ADMIN.
          if (!canArchive) delete body.visibility;
          await update.mutateAsync(body);
          toast(t("projects.detail.saved"));
          setEditing(false);
        }}
      />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {canEdit ? (
          <Button variant="outline" onClick={() => setEditing(true)}>
            {t("common.edit")}
          </Button>
        ) : null}
        {canArchive ? (
          <Button variant="destructive" onClick={() => setConfirming(true)}>
            {t("projects.detail.archive")}
          </Button>
        ) : null}
      </div>
      <dl className="grid max-w-3xl grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[10rem_1fr]">
        <dt className="text-muted-foreground">{t("projects.form.description")}</dt>
        <dd className="whitespace-pre-wrap">{project.description || "—"}</dd>
        <dt className="text-muted-foreground">{t("projects.form.keywords")}</dt>
        <dd className="flex flex-wrap gap-1">{project.keywords?.length ? project.keywords.map((k) => <Badge key={k}>{k}</Badge>) : "—"}</dd>
        <dt className="text-muted-foreground">{t("projects.detail.period")}</dt>
        <dd>
          {project.start_date ?? "—"} ~ {project.end_date ?? "—"}
        </dd>
        <dt className="text-muted-foreground">{t("projects.detail.organizations")}</dt>
        <dd>
          <ul>
            {project.organizations.map((o) => (
              <li key={o.organization_id}>
                {o.name ?? o.organization_id} ({t(`projects.detail.orgRole.${o.role}`)})
              </li>
            ))}
          </ul>
        </dd>
        <dt className="text-muted-foreground">{t("projects.detail.createdAt")}</dt>
        <dd>
          <DateTime value={project.created_at} />
        </dd>
      </dl>
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
              toast(t("projects.detail.archived"));
            },
            onError: (e) => {
              setConfirming(false);
              toast(errorText(e), "error");
            },
          })
        }
      />
    </div>
  );
}

export function ProjectDetailScreen({ projectId }: { projectId: string }) {
  const t = useTranslations();
  const q = useGetProject(projectId);
  const [params, setParams] = useUrlQuery();
  const requested = params.get("tab");
  const tab: Tab = TABS.includes(requested as Tab) ? (requested as Tab) : "overview";
  const activity = useListAuditEvents({ project_id: projectId }, { enabled: tab === "activity" });

  if (q.isPending) return <DelayedSkeleton lines={5} />;
  if (q.isError) {
    if (asApiError(q.error).code === "FORBIDDEN") return <PublicSummary projectId={projectId} />;
    return <ErrorView error={q.error} onRetry={() => void q.refetch()} />;
  }
  const p = q.data;
  const archived = p.status === "ARCHIVED";
  const manager = (p.my_role === "PROJECT_OWNER" || p.my_role === "PROJECT_ADMIN") && !archived;

  return (
    <>
      <PageHeader title={p.name}>
        <div className="mt-2 flex flex-wrap gap-2">
          <ProjectStatusBadge status={p.status} />
          <Badge>{t(`enums.ProjectVisibility.${p.visibility}`)}</Badge>
          {p.my_role ? <Badge tone="info">{t(`enums.ProjectRole.${p.my_role}`)}</Badge> : null}
        </div>
      </PageHeader>
      {archived ? (
        <p role="status" className="mb-4 rounded-md border border-warning p-3 text-sm">
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
            <TabsTrigger key={k} value={k}>
              {t(`projects.detail.tabs.${k}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview">
          <Overview project={p} canEdit={manager} canArchive={p.my_role === "PROJECT_OWNER" && !archived} />
        </TabsContent>
        <TabsContent value="members">
          <MembersTab project={p} manager={manager} />
        </TabsContent>
        <TabsContent value="data">
          <ProjectDataTab projectId={projectId} />
        </TabsContent>
        <TabsContent value="activity">
          <AuditTimeline query={activity} />
        </TabsContent>
      </Tabs>
    </>
  );
}
