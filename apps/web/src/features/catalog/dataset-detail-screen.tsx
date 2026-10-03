"use client";
import { Button, cn, EmptyState, Tabs, TabsContent, TabsList, TabsTrigger } from "@nais/ui";
import { Info, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { AccessRequestDialog } from "@/features/governance/components/access-request-dialog";
import { useMeData } from "@/shared/hooks/use-me";
import { useUrlQuery } from "@/shared/hooks/use-url-query";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { useGetDataset, useListDatasetVersions } from "./api";
import { DatasetEditSheet } from "./components/dataset-edit-sheet";
import { About } from "./data-card/about";
import { DataCardHeader, VersionPicker } from "./data-card/header";
import { MetadataBlock } from "./data-card/metadata-block";
import { FactsPanel } from "./data-card/facts-panel";
import { pickVersion } from "./data-card/pick-version";
import { DatasetDiscussion } from "./data-card/dataset-discussion";
import { DatasetHistory } from "./data-card/dataset-history";
import { DatasetProjects } from "./data-card/dataset-projects";
import { OpenInProjectDialog } from "./data-card/open-in-project-dialog";
import { SectionNav, sectionId, type CardSection } from "./data-card/section-nav";
import { SideCard } from "./data-card/side-card";
import { ColumnTable } from "./explorer/column-table";
import { DataExplorer } from "./explorer/data-explorer";
import { useBreadcrumbs } from "@/shared/ui/breadcrumbs";
import { PanelHead } from "@/shared/ui/work-hero";
import { NewDraftDialog } from "./versions/new-draft-dialog";
import { VersionHistoryTab, versionAccess } from "./versions/version-history-tab";

// Section anchors land below the sticky top bar and section nav: html's scroll-padding-top (4rem) + 3rem = 112px.
const sectionCls = "scroll-mt-12 outline-none";
const rowCls = cn(sectionCls, "grid grid-cols-1 gap-6 xl:grid-cols-12");

/** `?tab=` values that name a Data Card section (notification links use ?tab=discussion) rather than a tab. */
const LINKED_SECTIONS: CardSection[] = ["projects", "discussion", "history"];

/**
 * Scroll to a section and focus it. The panels above it (Explorer, schema, metadata) are still loading on a deep link,
 * so the section is kept at the top while the page grows — until the reader scrolls, types or 4 s pass.
 */
function landOn(section: CardSection) {
  const el = document.getElementById(sectionId(section));
  if (!el) return;
  const go = () => el.scrollIntoView?.({ block: "start", behavior: "instant" });
  go();
  el.focus({ preventScroll: true });
  if (typeof ResizeObserver === "undefined") return;
  const resize = new ResizeObserver(go);
  const stop = () => {
    resize.disconnect();
    clearTimeout(timer);
    for (const e of ["wheel", "touchstart", "keydown", "pointerdown"]) window.removeEventListener(e, stop);
  };
  const timer = setTimeout(stop, 4000);
  for (const e of ["wheel", "touchstart", "keydown", "pointerdown"]) window.addEventListener(e, stop, { passive: true });
  resize.observe(document.body);
}

export function DatasetDetailScreen({ datasetId }: { datasetId: string }) {
  const t = useTranslations();
  const me = useMeData();
  const ds = useGetDataset(datasetId);
  useBreadcrumbs(ds.data ? [{ label: ds.data.title }] : []);
  const versions = useListDatasetVersions(datasetId);
  const [params, setParams] = useUrlQuery();
  const [editing, setEditing] = useState(false);
  const [newVersion, setNewVersion] = useState(false);
  const [openInProject, setOpenInProject] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const contactRef = useRef<HTMLElement>(null);
  const linked = LINKED_SECTIONS.find((s) => s === params.get("tab"));
  // Land once per ?tab= value: a new value (another notification link on the same page) lands again.
  const landed = useRef<CardSection | undefined>(undefined);
  useEffect(() => {
    if (!linked) {
      landed.current = undefined;
      return;
    }
    if (!ds.isSuccess || landed.current === linked) return;
    landed.current = linked;
    landOn(linked);
  }, [linked, ds.isSuccess]);

  if (ds.isPending) return <DelayedSkeleton lines={6} />;
  if (ds.isError) return <ErrorView error={ds.error} onRetry={() => void ds.refetch()} />;
  const d = ds.data;
  // DRAFT versions are visible only to the owner organization's steward/admin (M03 §6); the server filters too.
  const { steward, seesDrafts } = versionAccess(me, d);
  const versionItems = (versions.data?.items ?? []).filter((v) => v.status !== "DRAFT" || seesDrafts);
  const selected = pickVersion(versionItems, params.get("v"), seesDrafts);
  const tab = params.get("tab") === "versions" ? "versions" : "card";

  return (
    <>
      <DataCardHeader
        dataset={d}
        selected={selected}
        steward={steward}
        onEdit={() => setEditing(true)}
        onInquiry={() => contactRef.current?.focus()}
        onOpenInProject={() => setOpenInProject(true)}
      />
      {steward && versions.isSuccess && versionItems.length === 0 ? (
        <div role="status" className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-md bg-info-soft px-4 py-3 text-small text-fg">
          <span className="flex items-center gap-2">
            <Info aria-hidden="true" strokeWidth={1.75} className="size-4 shrink-0 text-info" />
            {t("data.detail.firstVersionHint")}
          </span>
          <Button size="sm" onClick={() => setNewVersion(true)}>
            {t("data.versioning.newDraft")}
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
            {steward && tab === "card" ? (
              <Button variant="ghost" onClick={() => setNewVersion(true)}>
                <Plus aria-hidden="true" strokeWidth={1.75} />
                {t("data.versioning.newDraft")}
              </Button>
            ) : null}
          </div>
        </div>
        <TabsContent value="card" className="pt-0">
          <SectionNav initial={linked} />
          {/* 12-column rows from xl: 개요 (About 8 · 한눈에 4), 파일·분포 (Explorer 8 · rail 4, top-aligned), then schema and
              metadata at full width, then 프로젝트 · 토론 · 이력 (full width, crumb heads). Below xl every row stacks. */}
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
            <section id={sectionId("projects")} tabIndex={-1} aria-labelledby="card-projects-title" className={cn(sectionCls, "flex flex-col gap-4")}>
              <PanelHead id="card-projects-title" crumb={t("data.card.hero.projectsCrumb")} title={t("data.card.projectsTitle")} />
              <DatasetProjects datasetId={d.dataset_id} />
            </section>
            <section id={sectionId("discussion")} tabIndex={-1} aria-labelledby="card-discussion-title" className={cn(sectionCls, "flex flex-col gap-4")}>
              <DatasetDiscussion datasetId={d.dataset_id} steward={steward} titleId="card-discussion-title" />
            </section>
            <section id={sectionId("history")} tabIndex={-1} aria-labelledby="card-history-title" className={cn(sectionCls, "flex flex-col gap-4")}>
              <PanelHead id="card-history-title" crumb={t("data.card.hero.historyCrumb")} title={t("data.card.historyTitle")} />
              <DatasetHistory
                datasetId={d.dataset_id}
                onOpenThread={(threadId) => {
                  setParams({ thread: threadId });
                  landOn("discussion");
                }}
              />
            </section>
          </div>
          <div id="card-end" aria-hidden="true" className="h-px" />
        </TabsContent>
        <TabsContent value="versions">
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
            <div className="min-w-0 xl:col-span-8">
              <VersionHistoryTab dataset={d} />
            </div>
            <div className="xl:col-span-4">
              <SideCard ref={contactRef} dataset={d} versions={versionItems} />
            </div>
          </div>
        </TabsContent>
      </Tabs>
      <OpenInProjectDialog
        dataset={d}
        version={selected}
        open={openInProject}
        onOpenChange={setOpenInProject}
        onRequestAccess={() => {
          setOpenInProject(false);
          setRequesting(true);
        }}
      />
      <AccessRequestDialog dataset={d} open={requesting} onOpenChange={setRequesting} />
      {steward ? <DatasetEditSheet dataset={d} open={editing} onOpenChange={setEditing} /> : null}
      {steward ? <NewDraftDialog datasetId={d.dataset_id} latestLabel={d.latest_published_version?.version_label ?? null} open={newVersion} onOpenChange={setNewVersion} /> : null}
    </>
  );
}
