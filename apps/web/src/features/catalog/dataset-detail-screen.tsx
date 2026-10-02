"use client";
import { Button, EmptyState, Tabs, TabsContent, TabsList, TabsTrigger } from "@nais/ui";
import { Info, Plus } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { useMeData } from "@/shared/hooks/use-me";
import { useUrlQuery } from "@/shared/hooks/use-url-query";
import { VersionStatusBadge } from "@/shared/ui/badges";
import { DateTime } from "@/shared/ui/date-text";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { notify } from "@/shared/ui/toast";
import { useGetDataset, useListDatasetVersions, usePutDatasetContributors, useUpdateDataset } from "./api";
import { DatasetForm } from "./components/dataset-form";
import { NewVersionDialog } from "./components/new-version-dialog";
import { About } from "./data-card/about";
import { DataCardHeader, VersionPicker } from "./data-card/header";
import { MetadataBlock } from "./data-card/metadata-block";
import { pickVersion } from "./data-card/pick-version";
import { SideCard } from "./data-card/side-card";
import { ColumnTable } from "./explorer/column-table";
import { DataExplorer } from "./explorer/data-explorer";
import { contributorsChanged, fromDataset, toDatasetUpdate } from "./schemas";
import { useBreadcrumbs } from "@/shared/ui/breadcrumbs";
import { SectionHead } from "./components/section-head";

export function DatasetDetailScreen({ datasetId }: { datasetId: string }) {
  const t = useTranslations();
  const me = useMeData();
  const ds = useGetDataset(datasetId);
  useBreadcrumbs(ds.data ? [{ label: ds.data.title }] : []);
  const versions = useListDatasetVersions(datasetId);
  const update = useUpdateDataset(datasetId);
  const putContributors = usePutDatasetContributors(datasetId);
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
      <DataCardHeader dataset={d} selected={selected} steward={steward} onEdit={() => setEditing((e) => !e)} onInquiry={() => contactRef.current?.focus()} />
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
      {editing ? (
        <DatasetForm
          mode="edit"
          defaultValues={fromDataset(d)}
          ownerName={d.owner_organization_name ?? ""}
          ownerOrganizationId={d.owner_organization_id}
          onCancel={() => setEditing(false)}
          onSubmit={async (values) => {
            const before = fromDataset(d);
            const patch = toDatasetUpdate(values, before);
            if (Object.keys(patch).length) await update.mutateAsync(patch);
            if (contributorsChanged(before, values)) {
              await putContributors.mutateAsync({ contributors: values.contributors.map((c) => ({ user_id: c.user_id, role: c.role })) });
            }
            notify.success(t("data.detail.saved"));
            setEditing(false);
          }}
        />
      ) : (
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
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
            <div className="min-w-0">
              <TabsContent value="card" className="flex flex-col gap-10">
                <About description={d.description} />
                {selected ? (
                  <DataExplorer key={selected.dataset_version_id} dataset={d} versionId={selected.dataset_version_id} fileCount={selected.file_count ?? d.stats?.file_count ?? 0} />
                ) : null}
                <section aria-labelledby="columns-title" data-testid="column-table-slot" id="column-table-slot" className="flex flex-col gap-4">
                  <SectionHead id="columns-title" eyebrow={t("data.card.hero.columnsCrumb")} title={t("data.card.columnsTitle")} />
                  {selected ? <ColumnTable versionId={selected.dataset_version_id} /> : null}
                </section>
                <MetadataBlock dataset={d} />
              </TabsContent>
              <TabsContent value="versions">
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
              </TabsContent>
            </div>
            <div className="lg:pt-10">
              <SideCard ref={contactRef} dataset={d} versions={versionItems} />
            </div>
          </div>
        </Tabs>
      )}
      {steward ? <NewVersionDialog datasetId={d.dataset_id} open={newVersion} onOpenChange={setNewVersion} /> : null}
    </>
  );
}
