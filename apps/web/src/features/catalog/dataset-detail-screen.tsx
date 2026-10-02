"use client";
import { Button, EmptyState, Tabs, TabsContent, TabsList, TabsTrigger } from "@nais/ui";
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
import { ActivitySummary } from "./data-card/activity-summary";
import { DataCardHeader } from "./data-card/header";
import { MetadataBlock } from "./data-card/metadata-block";
import { pickVersion } from "./data-card/pick-version";
import { SideCard } from "./data-card/side-card";
import { ColumnTable } from "./explorer/column-table";
import { DataExplorer } from "./explorer/data-explorer";
import { contributorsChanged, fromDataset, toDatasetUpdate } from "./schemas";
import { useBreadcrumbs } from "@/shared/ui/breadcrumbs";

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
      <DataCardHeader
        dataset={d}
        versions={versionItems}
        selected={selected}
        onSelectVersion={(id) => setParams({ v: id })}
        onInquiry={() => contactRef.current?.focus()}
        steward={steward}
        onEdit={() => setEditing((e) => !e)}
        onNewVersion={() => setNewVersion(true)}
      />
      {steward && versions.isSuccess && versionItems.length === 0 ? (
        <p role="status" className="mb-4 rounded-md border border-info p-3 text-sm">
          {t("data.detail.firstVersionHint")}{" "}
          <Button size="sm" variant="link" onClick={() => setNewVersion(true)}>
            {t("data.version.newTitle")}
          </Button>
        </p>
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
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <Tabs value={tab} onValueChange={(v) => setParams({ tab: v === "versions" ? "versions" : null })}>
            <TabsList aria-label={t("data.card.tabsLabel")}>
              <TabsTrigger value="card">{t("data.card.tabCard")}</TabsTrigger>
              <TabsTrigger value="versions">{t("data.card.tabVersions")}</TabsTrigger>
            </TabsList>
            <TabsContent value="card" className="flex flex-col gap-8">
              <About description={d.description} />
              <section aria-labelledby="explorer-title">
                <h2 id="explorer-title" className="mb-2 text-lg font-semibold">
                  {t("data.card.explorerTitle")}
                </h2>
                <p className="mb-3 text-sm text-muted-foreground">{t("data.card.explorerFiles", { count: selected?.file_count ?? d.stats?.file_count ?? 0 })}</p>
                {selected ? <DataExplorer dataset={d} versionId={selected.dataset_version_id} /> : null}
              </section>
              <section aria-labelledby="columns-title" data-testid="column-table-slot" id="column-table-slot">
                <h2 id="columns-title" className="mb-2 text-lg font-semibold">
                  {t("data.card.columnsTitle")}
                </h2>
                {selected ? <ColumnTable versionId={selected.dataset_version_id} /> : null}
              </section>
              <MetadataBlock dataset={d} />
              <ActivitySummary versions={versionItems} />
            </TabsContent>
            <TabsContent value="versions">
              {versions.isPending ? (
                <DelayedSkeleton lines={2} />
              ) : versionItems.length === 0 ? (
                <EmptyState title={t("data.detail.noVersions")} />
              ) : (
                <ul className="flex flex-col gap-2 text-sm">
                  {versionItems.map((v) => (
                    <li key={v.dataset_version_id} className="flex flex-wrap items-center justify-between gap-2">
                      <Link href={`/commons/data/${d.dataset_id}/versions/${v.dataset_version_id}`} className="font-medium underline-offset-4 hover:underline">
                        {v.version_label}
                      </Link>
                      <span className="flex items-center gap-2">
                        <VersionStatusBadge status={v.status} />
                        <DateTime value={v.published_at ?? v.created_at} dateOnly />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </TabsContent>
          </Tabs>
          <SideCard ref={contactRef} dataset={d} />
        </div>
      )}
      {steward ? <NewVersionDialog datasetId={d.dataset_id} open={newVersion} onOpenChange={setNewVersion} /> : null}
    </>
  );
}
