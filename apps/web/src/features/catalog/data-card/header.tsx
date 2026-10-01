"use client";
import { Badge, Button, buttonClass } from "@nais/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useListAccessGrants, useListAccessRequests } from "@/features/governance/api";
import { AccessRequestDialog } from "@/features/governance/components/access-request-dialog";
import { flattenPages } from "@/shared/api/pagination";
import type { Dataset, DatasetVersion } from "@/shared/api/types";
import { useMeData } from "@/shared/hooks/use-me";
import { formatBytes } from "@/shared/lib/format";
import { AccessLevelBadge } from "@/shared/ui/badges";
import { DateTime, ExpiryText } from "@/shared/ui/date-text";
import { DelayedSkeleton } from "@/shared/ui/state-views";
import { decideAccessCta, type AccessCta as AccessCtaT } from "../access-cta";
import { AiReadyBadge } from "../components/ai-ready-badge";
import { JsonLdButton } from "./metadata-block";
import { PersonLine } from "../components/person-line";
import { VocabularyTags } from "../components/vocabulary-tags";

export function AccessCta({ dataset }: { dataset: Dataset }) {
  const t = useTranslations();
  const me = useMeData();
  const [requesting, setRequesting] = useState(false);
  const [notRequired, setNotRequired] = useState(false);
  const grants = useListAccessGrants({ role: "subject", dataset_id: dataset.dataset_id, status: ["ACTIVE"] });
  const requests = useListAccessRequests({ role: "requester", dataset_id: dataset.dataset_id });
  if (grants.isPending || requests.isPending) return <DelayedSkeleton lines={1} />;
  const decided = decideAccessCta({
    accessLevel: dataset.access_level,
    ownerOrganizationId: dataset.owner_organization_id,
    me,
    activeGrants: flattenPages(grants.data),
    requests: flattenPages(requests.data),
  });
  // ACCESS_NOT_REQUIRED from the server wins over our guess (M10 §7.9).
  const cta: AccessCtaT = notRequired ? { kind: "download", basis: "OWNER_ORGANIZATION" } : decided;
  const latest = dataset.latest_published_version;
  const downloadHref = latest ? `/commons/data/${dataset.dataset_id}/versions/${latest.dataset_version_id}?download=1` : null;

  switch (cta.kind) {
    case "download":
    case "download-grant":
      return (
        <div className="flex flex-col items-start gap-1">
          {downloadHref ? (
            <Link href={downloadHref} className={buttonClass("primary")}>
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
          <Button variant="primary" onClick={() => setRequesting(true)}>{t("access.request.title")}</Button>
          <AccessRequestDialog dataset={dataset} open={requesting} onOpenChange={setRequesting} onNotRequired={() => setNotRequired(true)} />
        </>
      );
    default:
      return <p className="text-sm text-muted-foreground">{t("data.detail.unavailable")}</p>;
  }
}

export function DataCardHeader({
  dataset: d,
  versions,
  selected,
  onSelectVersion,
  onInquiry,
  steward,
  onEdit,
  onNewVersion,
}: {
  dataset: Dataset;
  versions: DatasetVersion[];
  selected: DatasetVersion | undefined;
  onSelectVersion: (id: string) => void;
  onInquiry: () => void;
  steward: boolean;
  onEdit: () => void;
  onNewVersion: () => void;
}) {
  const t = useTranslations();
  const latestId = d.latest_published_version?.dataset_version_id;
  const pi = d.people?.principal_investigator;
  const sizeOf = (v: DatasetVersion) => (v.dataset_version_id === latestId && d.stats?.total_bytes !== undefined ? ` (${formatBytes(d.stats.total_bytes)})` : "");
  return (
    <header className="mb-6 flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold break-words">{d.title}</h1>
          {d.subtitle ? <p className="mt-1 text-muted-foreground">{d.subtitle}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AccessCta dataset={d} />
          <Button variant="outline" onClick={onInquiry}>
            {t("data.card.inquiry")}
          </Button>
          <JsonLdButton dataset={d} />
          {steward ? (
            <>
              <Button variant="outline" onClick={onEdit}>
                {t("common.edit")}
              </Button>
              <Button variant="outline" onClick={onNewVersion}>
                {t("data.version.newTitle")}
              </Button>
            </>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        {d.owner_organization_name ? <Badge tone="neutral">{d.owner_organization_name}</Badge> : null}
        <AccessLevelBadge level={d.access_level} />
        {pi ? <PersonLine person={pi} /> : null}
        {d.latest_published_version?.published_at ? (
          <span className="text-muted-foreground">
            {t("data.card.lastPublished")} <DateTime value={d.latest_published_version.published_at} dateOnly />
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        {versions.length ? (
          <label className="flex items-center gap-2 text-sm">
            {t("data.card.version")}
            <select
              className="min-h-10 rounded-md border border-input bg-background px-2"
              value={selected?.dataset_version_id ?? ""}
              onChange={(e) => onSelectVersion(e.target.value)}
            >
              {versions.map((v) => (
                <option key={v.dataset_version_id} value={v.dataset_version_id}>
                  {v.version_label}
                  {sizeOf(v)}
                  {v.status === "DRAFT" ? ` (${t("enums.DatasetVersionStatus.DRAFT")})` : ""}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {selected?.status === "PUBLISHED" ? <AiReadyBadge versionId={selected.dataset_version_id} /> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {d.keywords?.length ? (
          <ul className="flex flex-wrap gap-1">
            {d.keywords.map((k) => (
              <li key={k}>
                <Badge tone="info">{k}</Badge>
              </li>
            ))}
          </ul>
        ) : null}
        <VocabularyTags scheme="SUBJECT" codes={d.subject_codes ?? []} />
      </div>
    </header>
  );
}
