"use client";
import { Badge, Button, buttonClass, SelectMenu, Skeleton } from "@nais/ui";
import { MessageSquare, NotebookPen, Pencil } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useListAccessGrants, useListAccessRequests } from "@/features/governance/api";
import { AccessRequestDialog } from "@/features/governance/components/access-request-dialog";
import { flattenPages } from "@/shared/api/pagination";
import type { Dataset, DatasetVersion } from "@/shared/api/types";
import { useMeData } from "@/shared/hooks/use-me";
import { formatBytes, formatDate } from "@/shared/lib/format";
import { AccessLevelBadge } from "@/shared/ui/badges";
import { ExpiryText } from "@/shared/ui/date-text";
import { decideAccessCta, type AccessCta as AccessCtaT } from "../access-cta";
import { AiReadyMeter } from "../components/ai-ready-badge";
import { BandTag, SummaryBand, type BandFact } from "@/shared/ui/screen-v2";
import "../components/v2.css";
import { useVocabularyLabels } from "../api";

/** The page's one primary action: download, view my request, or request access (decided by access-cta.ts). */
export function AccessCta({ dataset }: { dataset: Dataset }) {
  const t = useTranslations();
  const me = useMeData();
  const [requesting, setRequesting] = useState(false);
  const [notRequired, setNotRequired] = useState(false);
  const grants = useListAccessGrants({ role: "subject", dataset_id: dataset.dataset_id, status: ["ACTIVE"] });
  const requests = useListAccessRequests({ role: "requester", dataset_id: dataset.dataset_id });
  // Same footprint as the button it stands in for, so the header does not jump.
  if (grants.isPending || requests.isPending) return <Skeleton className="h-8 w-24" />;
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
        <div className="flex flex-col items-end gap-1">
          {downloadHref ? (
            <Link href={downloadHref} className={buttonClass("primary")}>
              {t("data.detail.download")}
            </Link>
          ) : (
            <p className="text-small text-fg-muted">{t("data.detail.noPublishedVersion")}</p>
          )}
          {cta.kind === "download-grant" ? (
            <span className="text-caption [&_span]:text-caption">
              <ExpiryText value={[...cta.grants].sort((a, b) => a.expires_at.localeCompare(b.expires_at))[0]!.expires_at} />
            </span>
          ) : null}
        </div>
      );
    case "view-request":
      return (
        <Link href={`/commons/access/${cta.accessRequestId}`} className={buttonClass("secondary")}>
          {t("data.detail.viewRequest")}
        </Link>
      );
    case "request":
      return (
        <>
          <Button variant="primary" onClick={() => setRequesting(true)}>
            {t("access.request.title")}
          </Button>
          <AccessRequestDialog dataset={dataset} open={requesting} onOpenChange={setRequesting} onNotRequired={() => setNotRequired(true)} />
        </>
      );
    default:
      return <p className="max-w-60 text-small text-fg-muted">{t("data.detail.unavailable")}</p>;
  }
}

/** Version switcher above the card (styled listbox). The latest version's size rides along in its label. */
export function VersionPicker({
  dataset: d,
  versions,
  selected,
  onSelect,
}: {
  dataset: Dataset;
  versions: DatasetVersion[];
  selected: DatasetVersion | undefined;
  onSelect: (id: string) => void;
}) {
  const t = useTranslations();
  if (!versions.length) return null;
  const latestId = d.latest_published_version?.dataset_version_id;
  const options = versions.map((v) => ({
    value: v.dataset_version_id,
    label: (
      <span className="flex items-baseline gap-2">
        <span className="font-mono text-mono">{v.version_label}</span>
        {v.dataset_version_id === latestId && d.stats?.total_bytes !== undefined ? <span className="num text-small text-fg-muted">{formatBytes(d.stats.total_bytes)}</span> : null}
        {v.status === "DRAFT" ? <span className="text-small text-fg-muted">{t("data.card.draftSuffix")}</span> : null}
      </span>
    ),
  }));
  return (
    <SelectMenu
      aria-label={t("data.card.versionPicker")}
      options={options}
      value={selected?.dataset_version_id ?? null}
      onValueChange={(v) => v && onSelect(v)}
      className="w-auto min-w-36"
    />
  );
}

/**
 * Data Card header (UI v2): the shared SummaryBand. Context (연구 데이터 · owner · subjects) over the bold title; the
 * subtitle and keyword tags under it; actions — 문의 · 새 노트북 (예정) · the access CTA as the one primary, with 편집
 * as a quiet ghost for the owner steward; then the fact row: PI · NTIS, period, version · publish date, and the
 * AI-ready score as a compact meter. App controls inside the band sit in a `.dark` wrapper so they use dark tokens.
 */
export function DataCardHeader({
  dataset: d,
  selected,
  steward,
  onEdit,
  onInquiry,
}: {
  dataset: Dataset;
  selected: DatasetVersion | undefined;
  steward: boolean;
  onEdit: () => void;
  onInquiry: () => void;
}) {
  const t = useTranslations();
  const vocab = useVocabularyLabels();
  const pi = d.people?.principal_investigator;
  const period = d.temporal_start ? `${d.temporal_start} – ${d.temporal_end ?? t("data.meta.ongoing")}` : null;
  const latest = d.latest_published_version;
  const subjects = (d.subject_codes ?? []).map((c) => vocab("SUBJECT", c));
  const facts: BandFact[] = [
    {
      label: t("data.card.hero.pi"),
      kind: "text",
      value: pi ? (
        <>
          {pi.display_name}{" "}
          {pi.national_researcher_number ? <span className="num font-mono text-mono font-normal tracking-normal text-hero-fg-muted">NTIS {pi.national_researcher_number}</span> : null}
        </>
      ) : (
        (d.owner_organization_name ?? "—")
      ),
    },
    { label: t("data.card.hero.period"), kind: "mono", value: period ?? "—" },
    {
      label: t("data.card.hero.version"),
      kind: "mono",
      value: latest ? <span className="font-mono">{latest.version_label}</span> : "—",
      unit: latest?.published_at ? ` ${formatDate(latest.published_at)} ${t("data.card.published")}` : undefined,
    },
    {
      label: t("data.card.hero.aiReady"),
      kind: "text",
      value: (
        <span className="dark block pt-1">
          {selected?.status === "PUBLISHED" ? <AiReadyMeter versionId={selected.dataset_version_id} /> : <span className="text-small font-normal text-fg-muted">{t("data.card.aiReadyUnverified")}</span>}
        </span>
      ),
    },
  ];
  return (
    <div className="nx-card-band">
      <SummaryBand
        label={t("data.card.metaLabel")}
        context={[t("data.card.hero.crumb"), d.owner_organization_name, ...subjects]}
        title={d.title}
        tags={
          <>
            {d.subtitle ? <p className="mb-1.5 basis-full break-keep text-long text-hero-fg-muted">{d.subtitle}</p> : null}
            <span className="dark contents">
              <AccessLevelBadge level={d.access_level} />
            </span>
            {(d.keywords ?? []).map((k) => (
              <BandTag key={k}>{k}</BandTag>
            ))}
          </>
        }
        actions={
          <div className="dark flex flex-wrap items-start gap-2">
            {steward ? (
              <Button variant="ghost" onClick={onEdit}>
                <Pencil aria-hidden="true" strokeWidth={1.75} />
                {t("common.edit")}
              </Button>
            ) : null}
            <Button onClick={onInquiry}>
              <MessageSquare aria-hidden="true" strokeWidth={1.75} />
              {t("data.card.inquiry")}
            </Button>
            <Button disabled>
              <NotebookPen aria-hidden="true" strokeWidth={1.75} />
              {t("data.card.newNotebook")}
              <Badge tone="neutral" className="-mr-1">
                {t("data.card.soon")}
              </Badge>
            </Button>
            <AccessCta dataset={d} />
          </div>
        }
        facts={facts}
      />
    </div>
  );
}
