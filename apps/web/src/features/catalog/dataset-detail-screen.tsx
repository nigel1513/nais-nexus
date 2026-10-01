"use client";
import { Badge, Button, buttonClass, Card, CardContent, CardHeader, CardTitle, EmptyState } from "@nais/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useListAccessGrants, useListAccessRequests } from "@/features/governance/api";
import { AccessRequestDialog } from "@/features/governance/components/access-request-dialog";
import { useGetReadiness } from "@/features/readiness/api";
import { flattenPages } from "@/shared/api/pagination";
import type { Dataset } from "@/shared/api/types";
import { useMeData } from "@/shared/hooks/use-me";
import { AccessLevelBadge, ReadinessBadge, VersionStatusBadge } from "@/shared/ui/badges";
import { DateTime, ExpiryText } from "@/shared/ui/date-text";
import { PageHeader } from "@/shared/ui/page-header";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { useToast } from "@/shared/ui/toast";
import { decideAccessCta } from "./access-cta";
import { useGetDataset, useListDatasetVersions, useUpdateDataset } from "./api";
import { DatasetForm } from "./components/dataset-form";
import { NewVersionDialog } from "./components/new-version-dialog";
import { fromDataset, toDatasetUpdate } from "./schemas";

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words">{children}</dd>
    </>
  );
}

function AccessCta({ dataset }: { dataset: Dataset }) {
  const t = useTranslations();
  const me = useMeData();
  const [requesting, setRequesting] = useState(false);
  const grants = useListAccessGrants({ role: "subject", dataset_id: dataset.dataset_id, status: ["ACTIVE"] });
  const requests = useListAccessRequests({ role: "requester", dataset_id: dataset.dataset_id });
  if (grants.isPending || requests.isPending) return <DelayedSkeleton lines={1} />;
  const cta = decideAccessCta({
    accessLevel: dataset.access_level,
    ownerOrganizationId: dataset.owner_organization_id,
    me,
    activeGrants: flattenPages(grants.data),
    requests: flattenPages(requests.data),
  });
  const latest = dataset.latest_published_version;
  const downloadHref = latest ? `/commons/data/${dataset.dataset_id}/versions/${latest.dataset_version_id}?download=1` : null;

  switch (cta.kind) {
    case "download":
    case "download-grant":
      return (
        <div className="flex flex-col items-start gap-1">
          {downloadHref ? (
            <Link href={downloadHref} className={buttonClass()}>
              {t("data.detail.download")}
            </Link>
          ) : (
            <p className="text-sm text-muted-foreground">{t("data.detail.noPublishedVersion")}</p>
          )}
          {cta.kind === "download-grant" ? <ExpiryText value={[...cta.grants].sort((a, b) => a.expires_at.localeCompare(b.expires_at))[0]!.expires_at} /> : null}
        </div>
      );
    case "view-request":
      return (
        <Link href={`/commons/access/${cta.accessRequestId}`} className={buttonClass("outline")}>
          {t("data.detail.viewRequest")}
        </Link>
      );
    case "request":
      return (
        <>
          <Button onClick={() => setRequesting(true)}>{t("access.request.title")}</Button>
          <AccessRequestDialog dataset={dataset} open={requesting} onOpenChange={setRequesting} />
        </>
      );
    default:
      return <p className="text-sm text-muted-foreground">{t("data.detail.unavailable")}</p>;
  }
}

export function DatasetDetailScreen({ datasetId, created = false }: { datasetId: string; created?: boolean }) {
  const t = useTranslations();
  const me = useMeData();
  const toast = useToast();
  const ds = useGetDataset(datasetId);
  const versions = useListDatasetVersions(datasetId);
  const update = useUpdateDataset(datasetId);
  const latestId = ds.data?.latest_published_version?.dataset_version_id;
  const readiness = useGetReadiness(latestId ?? "none", { enabled: !!latestId });
  const [editing, setEditing] = useState(false);
  const [newVersion, setNewVersion] = useState(false);

  if (ds.isPending) return <DelayedSkeleton lines={6} />;
  if (ds.isError) return <ErrorView error={ds.error} onRetry={() => void ds.refetch()} />;
  const d = ds.data;
  const steward = me.organization.organization_id === d.owner_organization_id && me.org_roles.includes("DATA_STEWARD");
  // DRAFT versions are visible only to the owner organization's steward/admin (M03 §6); the server filters too.
  const ownOrg = me.organization.organization_id === d.owner_organization_id;
  const seesDrafts = (ownOrg && (me.org_roles.includes("DATA_STEWARD") || me.org_roles.includes("ORG_ADMIN"))) || me.platform_roles.includes("PLATFORM_ADMIN");
  const versionItems = (versions.data?.items ?? []).filter((v) => v.status !== "DRAFT" || seesDrafts);

  return (
    <>
      <PageHeader
        title={d.title}
        actions={
          <>
            <AccessCta dataset={d} />
            {steward ? (
              <>
                <Button variant="outline" onClick={() => setEditing((e) => !e)}>
                  {t("common.edit")}
                </Button>
                <Button variant="outline" onClick={() => setNewVersion(true)}>
                  {t("data.version.newTitle")}
                </Button>
              </>
            ) : null}
          </>
        }
      >
        <div className="mt-2 flex flex-wrap gap-2">
          <AccessLevelBadge level={d.access_level} />
          <ReadinessBadge value={d.latest_published_version?.readiness_overall} />
          <Badge>{d.owner_organization_name ?? d.owner_organization_id}</Badge>
        </div>
      </PageHeader>
      {steward && (created || versionItems.length === 0) && versions.isSuccess && versionItems.length === 0 ? (
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
          onCancel={() => setEditing(false)}
          onSubmit={async (values) => {
            await update.mutateAsync(toDatasetUpdate(values));
            toast(t("data.detail.saved"));
            setEditing(false);
          }}
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
          <section aria-labelledby="dataset-meta">
            <h2 id="dataset-meta" className="mb-3 text-lg font-semibold">
              {t("data.detail.metadata")}
            </h2>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[9rem_1fr]">
              <Meta label={t("data.form.description")}>{d.description || "—"}</Meta>
              <Meta label={t("data.form.keywords")}>{d.keywords?.length ? d.keywords.join(", ") : "—"}</Meta>
              <Meta label={t("data.form.domain")}>{d.domain ?? "—"}</Meta>
              <Meta label={t("data.form.license")}>{d.license}</Meta>
              <Meta label={t("data.form.usagePolicy")}>{d.usage_policy ?? "—"}</Meta>
              <Meta label={t("data.form.provenance")}>{d.provenance ?? "—"}</Meta>
              <Meta label={t("data.form.contactEmail")}>{d.contact_email ?? "—"}</Meta>
              <Meta label={t("data.search.updated")}>
                <DateTime value={d.updated_at} />
              </Meta>
            </dl>
          </section>
          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle>{t("data.detail.policy")}</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
                  <Meta label={t("data.form.allowedPurposes")}>{d.policy.allowed_purposes.map((p) => t(`enums.Purpose.${p}`)).join(", ")}</Meta>
                  <Meta label={t("data.form.maxGrantDays")}>{t("data.detail.days", { count: d.policy.max_grant_days })}</Meta>
                  <Meta label={t("data.detail.approvalRequired")}>{d.policy.approval_required ? t("common.yes") : t("common.no")}</Meta>
                </dl>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t("data.detail.readiness")}</CardTitle>
              </CardHeader>
              <CardContent>
                {!latestId ? (
                  <p className="text-sm text-muted-foreground">{t("data.detail.noPublishedVersion")}</p>
                ) : readiness.isPending ? (
                  <DelayedSkeleton lines={2} />
                ) : (
                  <ul className="flex flex-col gap-2 text-sm">
                    {(readiness.data?.items ?? []).map((v) => (
                      <li key={v.validation_id} className="flex items-center justify-between gap-2">
                        <span>{v.profile_id}</span>
                        <ReadinessBadge value={v.overall_status} />
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t("data.detail.versions")}</CardTitle>
              </CardHeader>
              <CardContent>
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
              </CardContent>
            </Card>
          </div>
        </div>
      )}
      {steward ? <NewVersionDialog datasetId={d.dataset_id} open={newVersion} onOpenChange={setNewVersion} /> : null}
    </>
  );
}
