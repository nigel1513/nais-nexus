"use client";
import { buttonClass, DataTable, EmptyState, Select, Tabs, TabsContent, TabsList, TabsTrigger } from "@nais/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useOrgNames } from "@/features/organizations/api";
import { flattenPages } from "@/shared/api/pagination";
import type { ProjectStatus, ProjectSummary } from "@/shared/api/types";
import { useDebouncedValue } from "@/shared/hooks/use-debounced-value";
import { useUrlQuery } from "@/shared/hooks/use-url-query";
import { ProjectStatusBadge } from "@/shared/ui/badges";
import { DateTime } from "@/shared/ui/date-text";
import { PageHeader } from "@/shared/ui/page-header";
import { DelayedSkeleton, ErrorView, LoadMore } from "@/shared/ui/state-views";
import { useListProjects } from "./api";

type Tab = "mine" | "discover";

export function ProjectsListScreen() {
  const t = useTranslations();
  const orgNames = useOrgNames();
  const [params, setParams] = useUrlQuery();
  const [tab, setTab] = useState<Tab>(params.get("tab") === "discover" ? "discover" : "mine");
  const [q, setQ] = useState(params.get("q") ?? "");
  const [status, setStatus] = useState(params.get("status") ?? "");
  const debounced = useDebouncedValue(q.trim(), 300);

  useEffect(() => {
    if ((params.get("q") ?? "") !== debounced) setParams({ q: debounced || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to the debounced value
  }, [debounced]);

  const query = useListProjects({ scope: tab, ...(debounced ? { q: debounced } : {}), ...(status ? { status: status as ProjectStatus } : {}) });
  const rows = flattenPages(query.data);

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
              <EmptyState title={t("projects.list.noMatch")} />
            ) : tab === "mine" ? (
              <EmptyState
                title={t("projects.list.emptyMine")}
                action={
                  <Link href="/commons/projects/new" className={buttonClass()}>
                    {t("projects.new.title")}
                  </Link>
                }
              />
            ) : (
              <EmptyState title={t("projects.list.emptyDiscover")} />
            )
          }
          columns={[
            {
              key: "name",
              header: t("projects.list.name"),
              cell: (p) => (
                <Link href={`/commons/projects/${p.project_id}`} className="font-medium underline-offset-4 hover:underline">
                  {p.name}
                </Link>
              ),
            },
            { key: "lead", header: t("projects.list.lead"), cell: (p) => p.lead_organization_name ?? orgNames[p.lead_organization_id] ?? "—" },
            { key: "role", header: t("projects.list.myRole"), cell: (p) => (p.my_role ? t(`enums.ProjectRole.${p.my_role}`) : "—") },
            { key: "members", header: t("projects.list.members"), cell: (p) => p.member_count ?? "—" },
            { key: "status", header: t("projects.list.status"), cell: (p) => <ProjectStatusBadge status={p.status} /> },
            { key: "updated", header: t("projects.list.updated"), cell: (p) => <DateTime value={p.updated_at} dateOnly /> },
          ]}
        />
      )}
      <LoadMore hasNextPage={query.hasNextPage} isFetchingNextPage={query.isFetchingNextPage} fetchNextPage={query.fetchNextPage} />
    </>
  );

  return (
    <>
      <PageHeader
        title={t("projects.list.title")}
        actions={
          <Link href="/commons/projects/new" className={buttonClass()}>
            {t("projects.new.title")}
          </Link>
        }
      />
      <Tabs
        value={tab}
        onValueChange={(v) => {
          setTab(v as Tab);
          setParams({ tab: v === "mine" ? null : v });
        }}
      >
        <TabsList aria-label={t("projects.list.tabsLabel")}>
          <TabsTrigger value="mine">{t("projects.list.mine")}</TabsTrigger>
          <TabsTrigger value="discover">{t("projects.list.discover")}</TabsTrigger>
        </TabsList>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="min-w-60 flex-1">
            <label htmlFor="project-search" className="sr-only">
              {t("projects.list.search")}
            </label>
            <input
              id="project-search"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("projects.list.searchPlaceholder")}
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
            />
          </div>
          <div>
            <label htmlFor="project-status" className="sr-only">
              {t("projects.list.status")}
            </label>
            <Select
              id="project-status"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setParams({ status: e.target.value || null });
              }}
            >
              <option value="">{t("projects.list.allStatuses")}</option>
              <option value="ACTIVE">{t("enums.ProjectStatus.ACTIVE")}</option>
              <option value="ARCHIVED">{t("enums.ProjectStatus.ARCHIVED")}</option>
            </Select>
          </div>
        </div>
        <TabsContent value="mine">{tab === "mine" ? table : null}</TabsContent>
        <TabsContent value="discover">{tab === "discover" ? table : null}</TabsContent>
      </Tabs>
    </>
  );
}
