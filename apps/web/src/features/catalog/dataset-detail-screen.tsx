"use client";
import { Button, cn, EmptyState, Tabs, TabsContent, TabsList, TabsTrigger } from "@nais/ui";
import { Info, Plus } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { useMeData } from "@/shared/hooks/use-me";
import { useUrlQuery } from "@/shared/hooks/use-url-query";
import { VersionStatusBadge } from "@/shared/ui/badges";
import { DateTime } from "@/shared/ui/date-text";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { useGetDataset, useListDatasetVersions } from "./api";
import { DatasetEditSheet } from "./components/dataset-edit-sheet";
import { NewVersionDialog } from "./components/new-version-dialog";
import { About } from "./data-card/about";
import { DataCardHeader, VersionPicker } from "./data-card/header";
import { MetadataBlock } from "./data-card/metadata-block";
import { FactsPanel } from "./data-card/facts-panel";
import { pickVersion } from "./data-card/pick-version";
import { SectionNav, sectionId } from "./data-card/section-nav";
import { SideCard } from "./data-card/side-card";
import { ColumnTable } from "./explorer/column-table";
import { DataExplorer } from "./explorer/data-explorer";
import { useBreadcrumbs } from "@/shared/ui/breadcrumbs";
import { PanelHead } from "@/shared/ui/work-hero";

// Section anchors land below the sticky top bar and section nav: html's scroll-padding-top (4rem) + 3rem = 112px.
const sectionCls = "scroll-mt-12 outline-none";
const rowCls = cn(sectionCls, "grid grid-cols-1 gap-6 xl:grid-cols-12");

export function DatasetDetailScreen({ datasetId }: { datasetId: string }) {
  const t = useTranslations();
  const me = useMeData();
  const ds = useGetDataset(datasetId);
  useBreadcrumbs(ds.data ? [{ label: ds.data.title }] : []);
  const versions = useListDatasetVersions(datasetId);
  const [params, setParams] = useUrlQuery();
  const [editing, setEditing] = useState(false);
  const [newVersion, setNewVersion] = useState(false);
  const contactRef = useRef<HTMLElement>(null);

  if (ds.isPending) return <DelayedSkeleton lines={6} />;
  if (ds.isError) return <ErrorView error={ds.error} onRetry={() => void ds.refetch()} />;
  const d = ds.data;
  const steward = me.organization.organization_id === d.owner_organization_id && me.org_roles.includes("DATA_STEWARD");
  // DRAFT versions are visible only to the owner organization's steward/admin (M03 §6); the server filters too.
  const ownOrg = me.organization.organization_id === d.owner_organization_id;
  const seesDrafts = (ownOrg && (me.org_roles.includes("DATA_STEWARD") || me.org_roles.includes("ORG_ADMIN"))) || me.platform_roles.includes("PLATFORM_ADMIN");
  const versionItems = (versions.data?.items ?? []).filter((v) => v.status !== "DRAFT" || seesDrafts);
  const selected = pickVersion(versionItems, params.get("v"), seesDrafts);
  const tab = params.get("tab") === "versions" ? "versions" : "card";

  return (
    <>
      <DataCardHeader dataset={d} selected={selected} steward={steward} onEdit={() => setEditing(true)} onInquiry={() => contactRef.current?.focus()} />
      {steward && versions.isSuccess && versionItems.length === 0 ? (
        <div role="status" className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-md bg-info-soft px-4 py-3 text-small text-fg">
          <span className="flex items-center gap-2">
            <Info aria-hidden="true" strokeWidth={1.75} className="size-4 shrink-0 text-info" />
            {t("data.detail.firstVersionHint")}
          </span>
          <Button size="sm" onClick={() => setNewVersion(true)}>
            {t("data.version.newTitle")}
          </Button>
        </div>
      ) : null}
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v === "versions" ? "versions" : null })}>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border">
          <TabsList aria-label={t("data.card.tabsLabel")} className="border-0">
            <TabsTrigger value="card">{t("data.card.tabCard")}</TabsTrigger>
            <TabsTrigger value="versions">{t("data.card.tabVersions")}</TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-2 pb-2 sm:pb-0">
            <VersionPicker dataset={d} versions={versionItems} selected={selected} onSelect={(id) => setParams({ v: id })} />
            {steward ? (
              <Button variant="ghost" onClick={() => setNewVersion(true)}>
                <Plus aria-hidden="true" strokeWidth={1.75} />
                {t("data.version.newTitle")}
              </Button>
            ) : null}
          </div>
        </div>
        <TabsContent value="card" className="pt-0">
          <SectionNav />
          {/* 12-column rows from xl: 개요 (About 8 · 한눈에 4), 파일·분포 (Explorer 8 · rail 4, top-aligned), then schema and
              metadata at full width. Below xl every row stacks. */}
          <div className="flex flex-col gap-12 pt-6">
            <div id={sectionId("overview")} tabIndex={-1} className={cn(rowCls, "items-start")}>
              <About description={d.description} className="xl:col-span-8" />
              <div className="xl:col-span-4">
                <FactsPanel dataset={d} />
              </div>
            </div>
            <div id={sectionId("files")} tabIndex={-1} className={rowCls}>
              <div className="flex min-w-0 flex-col xl:col-span-8">
                {selected ? (
                  <DataExplorer key={selected.dataset_version_id} className="flex-1" dataset={d} versionId={selected.dataset_version_id} fileCount={selected.file_count ?? d.stats?.file_count ?? 0} />
                ) : (
                  <div className="flex flex-1 flex-col justify-center rounded-md border border-dashed border-border">
                    <EmptyState title={t("data.detail.noVersions")} />
                  </div>
                )}
              </div>
              <div className="xl:col-span-4">
                {/* Top-aligned with the Explorer; it fills down to the Explorer's bottom while the row fits the viewport,
                    and sticks under the section nav when the Explorer is taller (a long Column view). */}
                <SideCard ref={contactRef} dataset={d} versions={versionItems} className="xl:sticky xl:top-28 xl:min-h-[min(100%,calc(100dvh-8.5rem))]" />
              </div>
            </div>
            <section id={sectionId("schema")} tabIndex={-1} aria-labelledby="columns-title" data-testid="column-table-slot" className={cn(sectionCls, "flex flex-col gap-4")}>
              <PanelHead id="columns-title" crumb={t("data.card.hero.columnsCrumb")} title={t("data.card.columnsTitle")} />
              {selected ? <ColumnTable versionId={selected.dataset_version_id} /> : null}
            </section>
            <div id={sectionId("meta")} tabIndex={-1} className={sectionCls}>
              <MetadataBlock dataset={d} />
            </div>
          </div>
          <div id="card-end" aria-hidden="true" className="h-px" />
        </TabsContent>
        <TabsContent value="versions">
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
            <div className="min-w-0 xl:col-span-8">
              {versions.isPending ? (
                <DelayedSkeleton lines={2} />
              ) : versionItems.length === 0 ? (
                <EmptyState title={t("data.detail.noVersions")} />
              ) : (
                <ul className="flex flex-col divide-y divide-border border-y border-border text-small">
                  {versionItems.map((v) => (
                    <li key={v.dataset_version_id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                      <Link href={`/commons/data/${d.dataset_id}/versions/${v.dataset_version_id}`} className="font-mono text-mono font-medium text-fg underline-offset-4 hover:underline">
                        {v.version_label}
                      </Link>
                      <span className="flex items-center gap-3 text-fg-muted">
                        <VersionStatusBadge status={v.status} />
                        <span className="num">
                          <DateTime value={v.published_at ?? v.created_at} dateOnly />
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="xl:col-span-4">
              <SideCard ref={contactRef} dataset={d} versions={versionItems} />
            </div>
          </div>
        </TabsContent>
      </Tabs>
      {steward ? <DatasetEditSheet dataset={d} open={editing} onOpenChange={setEditing} /> : null}
      {steward ? <NewVersionDialog datasetId={d.dataset_id} open={newVersion} onOpenChange={setNewVersion} /> : null}
    </>
  );
}
