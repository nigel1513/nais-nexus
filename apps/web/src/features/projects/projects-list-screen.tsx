"use client";
import { buttonClass, DataTable, EmptyState, Input, Select, Tabs, TabsContent, TabsList, TabsTrigger } from "@nais/ui";
import { FolderKanban, Globe, Lock, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useOrgNames } from "@/features/organizations/api";
import { flattenPages } from "@/shared/api/pagination";
import type { ProjectStatus, ProjectSummary } from "@/shared/api/types";
import { useUrlText } from "@/shared/hooks/use-url-text";
import { useUrlQuery } from "@/shared/hooks/use-url-query";
import { ProjectStatusBadge } from "@/shared/ui/badges";
import { DateTime } from "@/shared/ui/date-text";
import { PageHeader } from "@/shared/ui/page-header";
import { DelayedSkeleton, ErrorView, LoadMore } from "@/shared/ui/state-views";
import { useListProjects } from "./api";
import { ProjectRoleBadge } from "./components/project-role-badge";

type Tab = "mine" | "discover";

export function ProjectsListScreen() {
  const t = useTranslations();
  const orgNames = useOrgNames();
  const [params, setParams] = useUrlQuery();
  const tab: Tab = params.get("tab") === "discover" ? "discover" : "mine";
  const status = params.get("status") ?? "";
  const [q, setQ, debounced] = useUrlText("q", params, setParams);

  const query = useListProjects({ scope: tab, ...(debounced ? { q: debounced } : {}), ...(status ? { status: status as ProjectStatus } : {}) });
  const rows = flattenPages(query.data);
  const newProject = (
    <Link href="/commons/projects/new" className={buttonClass("primary")}>
      <Plus aria-hidden="true" strokeWidth={1.75} />
      {t("projects.new.title")}
    </Link>
  );

  const table = (
    <>
      {query.isPending ? (
        <DelayedSkeleton lines={4} />
      ) : query.isError ? (
        <ErrorView error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <DataTable<ProjectSummary>
          caption={t(tab === "mine" ? "projects.list.mine" : "projects.list.discover")}
          rows={rows}
          rowKey={(p) => p.project_id}
          empty={
            debounced || status ? (
              <EmptyState icon={Search} title={t("projects.list.noMatch")} />
            ) : tab === "mine" ? (
              <EmptyState icon={FolderKanban} title={t("projects.list.emptyMine")} description={t("projects.list.emptyMineHint")} action={newProject} />
            ) : (
              <EmptyState icon={Globe} title={t("projects.list.emptyDiscover")} />
            )
          }
          columns={[
            {
              key: "name",
              header: t("projects.list.name"),
              className: "min-w-64",
              cell: (p) => (
                <span className="flex min-w-0 items-center gap-2">
                  {p.visibility === "PUBLIC" ? (
                    <Globe aria-label={t("enums.ProjectVisibility.PUBLIC")} className="size-3.5 shrink-0 text-fg-muted" strokeWidth={1.75} />
                  ) : (
                    <Lock aria-label={t("enums.ProjectVisibility.PRIVATE")} className="size-3.5 shrink-0 text-fg-muted" strokeWidth={1.75} />
                  )}
                  <Link href={`/commons/projects/${p.project_id}`} className="truncate font-medium text-fg underline-offset-4 hover:underline">
                    {p.name}
                  </Link>
                  {p.status === "ARCHIVED" ? <ProjectStatusBadge status={p.status} /> : null}
                </span>
              ),
            },
            { key: "lead", header: t("projects.list.lead"), cell: (p) => <span className="text-fg-muted">{p.lead_organization_name ?? orgNames[p.lead_organization_id] ?? "—"}</span> },
            { key: "members", header: t("projects.list.members"), numeric: true, cell: (p) => p.member_count ?? "—" },
            { key: "role", header: t("projects.list.myRole"), cell: (p) => (p.my_role ? <ProjectRoleBadge role={p.my_role} /> : <span className="text-fg-muted">—</span>) },
            { key: "updated", header: t("projects.list.updated"), numeric: true, cell: (p) => (p.updated_at ? <DateTime value={p.updated_at} dateOnly /> : "—") },
          ]}
        />
      )}
      <LoadMore hasNextPage={query.hasNextPage} isFetchingNextPage={query.isFetchingNextPage} fetchNextPage={query.fetchNextPage} />
    </>
  );

  return (
    <>
      <PageHeader title={t("projects.list.title")} description={t("projects.list.description")} actions={newProject} />
      <Tabs
        value={tab}
        onValueChange={(v) => {
          setParams({ tab: v === "mine" ? null : v });
        }}
      >
        <TabsList aria-label={t("projects.list.tabsLabel")}>
          <TabsTrigger value="mine">{t("projects.list.mine")}</TabsTrigger>
          <TabsTrigger value="discover">{t("projects.list.discover")}</TabsTrigger>
        </TabsList>
        <div className="mt-4 mb-3 flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-80">
            <label htmlFor="project-search" className="sr-only">
              {t("projects.list.search")}
            </label>
            <Search aria-hidden="true" strokeWidth={1.75} className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-muted" />
            <Input id="project-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("projects.list.searchPlaceholder")} className="pl-8" />
          </div>
          <label htmlFor="project-status" className="sr-only">
            {t("projects.list.status")}
          </label>
          <Select
            id="project-status"
            className="w-36"
            value={status}
            onChange={(e) => {
              setParams({ status: e.target.value || null });
            }}
          >
            <option value="">{t("projects.list.allStatuses")}</option>
            <option value="ACTIVE">{t("enums.ProjectStatus.ACTIVE")}</option>
            <option value="ARCHIVED">{t("enums.ProjectStatus.ARCHIVED")}</option>
          </Select>
          {query.isSuccess ? (
            <span className="num ml-auto text-small text-fg-muted" aria-live="polite">
              {t("projects.list.count", { count: rows.length, more: query.hasNextPage ? "more" : "none" })}
            </span>
          ) : null}
        </div>
        <TabsContent value="mine">{tab === "mine" ? table : null}</TabsContent>
        <TabsContent value="discover">{tab === "discover" ? table : null}</TabsContent>
      </Tabs>
    </>
  );
}
