"use client";
import { Badge, Button, buttonClass, SelectMenu, Skeleton } from "@nais/ui";
import { MessageSquare, NotebookPen, Pencil } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Fragment, useState, type ReactNode } from "react";
import { useListAccessGrants, useListAccessRequests } from "@/features/governance/api";
import { AccessRequestDialog } from "@/features/governance/components/access-request-dialog";
import { flattenPages } from "@/shared/api/pagination";
import type { Dataset, DatasetVersion } from "@/shared/api/types";
import { useMeData } from "@/shared/hooks/use-me";
import { formatBytes } from "@/shared/lib/format";
import { AccessLevelBadge } from "@/shared/ui/badges";
import { DateTime, ExpiryText } from "@/shared/ui/date-text";
import { decideAccessCta, type AccessCta as AccessCtaT } from "../access-cta";
import { AiReadyBadge } from "../components/ai-ready-badge";
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

function MetaLine({ items }: { items: ReactNode[] }) {
  const t = useTranslations();
  const shown = items.filter(Boolean);
  if (!shown.length) return null;
  return (
    <ul aria-label={t("data.card.metaLabel")} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-fg-muted">
      {shown.map((item, i) => (
        <Fragment key={i}>
          {i > 0 ? (
            <li aria-hidden="true" className="h-3 w-px bg-border">
              {""}
            </li>
          ) : null}
          <li className="flex items-baseline gap-1.5">{item}</li>
        </Fragment>
      ))}
    </ul>
  );
}

/**
 * Data Card header (reference A): title (display), subtitle, a meta line (PI · NTIS · organization | period |
 * version · published), a badge row, and the actions — 문의 · 새 노트북 (예정) · the access CTA as the one primary.
 * Owner stewards get 편집 as a quiet ghost action before them.
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
  const tags = [...(d.subject_codes ?? []).map((c) => vocab("SUBJECT", c)), ...(d.keywords ?? [])];
  return (
    <header className="mb-6 flex flex-col gap-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="break-words text-display text-fg">{d.title}</h1>
          {d.subtitle ? <p className="max-w-[72ch] text-long text-fg-muted">{d.subtitle}</p> : null}
          <MetaLine
            items={[
              pi ? (
                <>
                  <span className="font-medium text-fg">{pi.display_name}</span>
                  {pi.national_researcher_number ? <span className="num">NTIS {pi.national_researcher_number}</span> : null}
                  <span>{pi.affiliation.name}</span>
                </>
              ) : d.owner_organization_name ? (
                <span>{d.owner_organization_name}</span>
              ) : null,
              period ? <span className="num">{period}</span> : null,
              latest ? (
                <>
                  <span className="font-mono text-mono text-fg">{latest.version_label}</span>
                  {latest.published_at ? (
                    <span className="num">
                      <DateTime value={latest.published_at} dateOnly /> {t("data.card.published")}
                    </span>
                  ) : null}
                </>
              ) : null,
            ]}
          />
        </div>
        <div className="flex shrink-0 flex-wrap items-start gap-2">
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
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <AccessLevelBadge level={d.access_level} />
        {selected?.status === "PUBLISHED" ? <AiReadyBadge versionId={selected.dataset_version_id} /> : null}
        {tags.length ? <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" /> : null}
        {tags.map((tag) => (
          <span key={tag} className="inline-flex h-6 items-center rounded-sm border border-border px-2 text-caption text-fg">
            {tag}
          </span>
        ))}
      </div>
    </header>
  );
}
