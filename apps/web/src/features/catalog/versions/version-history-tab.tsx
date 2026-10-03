"use client";
import { Button, buttonClass, cn, EmptyState, Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@nais/ui";
import { Download, GitCompareArrows, GitBranchPlus, Plus, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState, type ReactNode } from "react";
import { useListAccessGrants } from "@/features/governance/api";
import { flattenPages } from "@/shared/api/pagination";
import type { Dataset, DatasetVersion, Me } from "@/shared/api/types";
import { useMeData } from "@/shared/hooks/use-me";
import { VersionStatusBadge } from "@/shared/ui/badges";
import { DateTime } from "@/shared/ui/date-text";
import { DelayedSkeleton } from "@/shared/ui/state-views";
import { PanelHead } from "@/shared/ui/work-hero";
import { decideAccessCta } from "../access-cta";
import { useListDatasetVersions } from "../api";
import { DiffStat } from "./diff-stat";
import { NewDraftDialog } from "./new-draft-dialog";

/**
 * Whether the viewer can download `d` (UI convenience, M10 §7.6: the server decides on every call). The grants query is
 * the one the header's AccessCta already runs, so it is usually cached; it only runs when the role alone does not decide.
 */
function useCanDownload(me: Me, d: Dataset) {
  const byRole = decideAccessCta({ accessLevel: d.access_level, ownerOrganizationId: d.owner_organization_id, me, activeGrants: [], requests: [] });
  const needsGrant = byRole.kind === "request";
  const grants = useListAccessGrants({ role: "subject", dataset_id: d.dataset_id, status: ["ACTIVE"] }, { enabled: needsGrant });
  if (!needsGrant) return byRole.kind === "download";
  const decided = decideAccessCta({ accessLevel: d.access_level, ownerOrganizationId: d.owner_organization_id, me, activeGrants: flattenPages(grants.data), requests: [] });
  return decided.kind === "download-grant";
}

/** Who may act on versions of `d`: stewards of the owner organization; DRAFTs are also visible to its ORG_ADMIN and platform admins (M03 §6). */
export function versionAccess(me: Me, d: Dataset) {
  const ownOrg = me.organization.organization_id === d.owner_organization_id;
  const steward = ownOrg && me.org_roles.includes("DATA_STEWARD");
  const seesDrafts = (ownOrg && (steward || me.org_roles.includes("ORG_ADMIN"))) || me.platform_roles.includes("PLATFORM_ADMIN");
  return { steward, seesDrafts };
}

const byNewest = (a: DatasetVersion, b: DatasetVersion) => (b.published_at ?? b.created_at).localeCompare(a.published_at ?? a.created_at);

/**
 * The 버전 tab as a commit list (spec §7 "버전·변경 내역"): open drafts on top for the steward, then every published or
 * withdrawn version newest first, each with its change note as the title, author and date, lineage, a `+a −r ~c`
 * summary against its previous version, and its actions (compare, download, new draft / revert).
 */
export function VersionHistoryTab({ dataset: d }: { dataset: Dataset }) {
  const t = useTranslations("data.versioning");
  const me = useMeData();
  const versions = useListDatasetVersions(d.dataset_id);
  const { steward, seesDrafts } = versionAccess(me, d);
  const canDownload = useCanDownload(me, d);
  const [dialog, setDialog] = useState<{ open: boolean; from?: { id: string; label: string } }>({ open: false });
  const titleId = useId();
  const draftsId = useId();
  const historyId = useId();

  const items = versions.data?.items ?? [];
  const labels = new Map(items.map((v) => [v.dataset_version_id, v.version_label]));
  const history = items.filter((v) => v.status !== "DRAFT").sort(byNewest);
  const drafts = seesDrafts ? items.filter((v) => v.status === "DRAFT").sort(byNewest) : [];
  const latest = history.find((v) => v.status === "PUBLISHED") ?? null;
  const names = authorNames(d, me);

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-4">
      <PanelHead
        id={titleId}
        crumb={t("crumb")}
        title={t("title")}
        right={
          <>
            <LabelRule />
            {steward ? (
              <Button variant="primary" size="sm" onClick={() => setDialog({ open: true })}>
                <Plus aria-hidden="true" strokeWidth={2} />
                {t("newDraft")}
              </Button>
            ) : null}
          </>
        }
      />
      {steward ? <p className="-mt-2 break-keep text-small text-fg-muted">{t("help")}</p> : null}

      {versions.isPending ? (
        <DelayedSkeleton lines={3} />
      ) : (
        <>
          {drafts.length ? (
            <div className="flex flex-col gap-2">
              <SubHead id={draftsId} label={t("drafts")} count={drafts.length} />
              <ul aria-labelledby={draftsId} className="divide-y divide-border rounded-md border border-dashed border-border-strong">
                {drafts.map((v) => (
                  <VersionRow key={v.dataset_version_id} dataset={d} version={v} names={names} labels={labels} />
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex flex-col gap-2">
            <SubHead id={historyId} label={t("publishedList")} count={history.length} />
            {history.length === 0 ? (
              <div className="rounded-md border border-dashed border-border">
                <EmptyState title={t("empty")} description={steward ? t("emptyHint") : undefined} />
              </div>
            ) : (
              <ul aria-labelledby={historyId} className="divide-y divide-border border-y border-border">
                {history.map((v) => (
                  <VersionRow
                    key={v.dataset_version_id}
                    dataset={d}
                    version={v}
                    names={names}
                    labels={labels}
                    latest={v === latest}
                    canDownload={canDownload}
                    action={
                      steward && v.status === "PUBLISHED" ? (
                        v === latest ? (
                          <Button variant="ghost" size="sm" onClick={() => setDialog({ open: true })}>
                            <GitBranchPlus aria-hidden="true" strokeWidth={1.75} />
                            {t("draftFromHere")}
                          </Button>
                        ) : (
                          <Button variant="ghost" size="sm" onClick={() => setDialog({ open: true, from: { id: v.dataset_version_id, label: v.version_label } })}>
                            <RotateCcw aria-hidden="true" strokeWidth={1.75} />
                            {t("revert")}
                          </Button>
                        )
                      ) : null
                    }
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
      {steward ? (
        <NewDraftDialog
          datasetId={d.dataset_id}
          latestLabel={latest?.version_label ?? null}
          fromVersion={dialog.from}
          open={dialog.open}
          onOpenChange={(open) => setDialog((s) => ({ ...s, open }))}
        />
      ) : null}
    </section>
  );
}

function SubHead({ id, label, count }: { id: string; label: string; count: number }) {
  return (
    <h3 className="sv-kicker">
      <span id={id}>{label}</span>
      <b>{count}</b>
    </h3>
  );
}

/** Creator ids resolve through the people the dataset already shows (and the viewer); otherwise the owner institute. */
function authorNames(d: Dataset, me: Me) {
  const people = [d.people?.principal_investigator, d.people?.steward_contact, ...(d.people?.contributors ?? [])];
  const map = new Map<string, string>();
  for (const p of people) if (p) map.set(p.user_id, p.display_name);
  map.set(me.user_id, me.display_name);
  return (id: string | undefined) => (id ? map.get(id) : undefined) ?? d.owner_organization_name ?? null;
}

function VersionRow({
  dataset: d,
  version: v,
  names,
  labels,
  latest,
  canDownload,
  action,
}: {
  dataset: Dataset;
  version: DatasetVersion;
  names: (id: string | undefined) => string | null;
  labels: Map<string, string>;
  latest?: boolean;
  canDownload?: boolean;
  action?: ReactNode;
}) {
  const t = useTranslations("data.versioning");
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const note = (v.change_note ?? "").trim();
  const [first = "", ...rest] = note.split("\n");
  const body = rest.join("\n").trim();
  const draft = v.status === "DRAFT";
  const href = `/commons/data/${d.dataset_id}/versions/${v.dataset_version_id}`;
  const author = names(v.created_by);
  const mono = (c: ReactNode) => <span className="font-mono text-[12.5px] text-fg">{c}</span>;
  const lineage = draft
    ? v.source_version_id && v.source_version_id !== v.base_version_id
      ? t.rich("lineageSource", { label: labels.get(v.source_version_id) ?? "?", v: mono })
      : v.base_version_id
        ? t.rich("lineageBase", { label: labels.get(v.base_version_id) ?? "?", v: mono })
        : null
    : v.source_version_id && v.source_version_id !== v.previous_version_id && labels.has(v.source_version_id)
      ? t.rich("lineageRevert", { label: labels.get(v.source_version_id)!, v: mono })
      : v.previous_version_id && labels.has(v.previous_version_id)
        ? t.rich("lineagePrevious", { label: labels.get(v.previous_version_id)!, v: mono })
        : t("lineageFirst");

  return (
    <li
      aria-label={`${v.version_label} ${first || t("noNote")}`}
      className="grid grid-cols-1 gap-x-6 gap-y-2.5 px-4 py-3.5 transition-colors duration-[var(--dur-fast)] [@media(hover:hover)]:hover:bg-bg-hover/60 md:grid-cols-[minmax(0,1fr)_auto]"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <p className={cn("min-w-0 break-keep text-[14.5px] font-semibold leading-snug tracking-[-0.015em]", first ? "text-fg" : "font-normal text-fg-muted")}>{first || t("noNote")}</p>
          {body ? (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={bodyId}
              onClick={() => setExpanded((e) => !e)}
              className="shrink-0 rounded-xs px-1 text-caption text-fg-muted outline-none hover:bg-bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-focus"
            >
              {expanded ? t("less") : t("more")}
            </button>
          ) : null}
        </div>
        {body ? (
          <p id={bodyId} hidden={!expanded} className="whitespace-pre-line break-keep text-small text-fg-muted">
            {body}
          </p>
        ) : null}
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-small text-fg-muted">
          {author ? <span className="font-medium text-fg">{author}</span> : null}
          {author ? <span aria-hidden="true">·</span> : null}
          <span className="num">
            <DateTime value={v.published_at ?? v.created_at} dateOnly /> {draft ? t("created") : t("published")}
          </span>
          {lineage ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{lineage}</span>
            </>
          ) : null}
          {draft && v.base_is_latest === false ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-warning">{t("baseStale")}</span>
            </>
          ) : null}
        </p>
      </div>
      <div className="flex flex-col gap-2 md:items-end">
        <div className="flex flex-wrap items-center gap-2.5">
          {v.change_summary ? <DiffStat summary={v.change_summary} /> : null}
          <span className="flex items-center gap-1.5">
            {draft || v.status === "WITHDRAWN" ? <VersionStatusBadge status={v.status} /> : null}
            {latest ? <span className="rounded-xs bg-accent-soft px-1.5 py-px text-caption font-semibold text-accent-fg">{t("latest")}</span> : null}
            <Link
              href={href}
              className="inline-flex h-7 items-center rounded-sm border border-border bg-bg-panel px-2 font-mono text-[12.5px] font-medium text-fg outline-none hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              {v.version_label}
            </Link>
            {draft ? (
              <Link href={href} className={buttonClass("secondary", "sm")}>
                {t("openDraft")}
              </Link>
            ) : null}
          </span>
        </div>
        {draft ? null : (
          <div className="-mx-2 flex flex-wrap items-center gap-0.5 md:mx-0 md:-mr-2 md:justify-end">
            {v.previous_version_id ? (
              <Link href={`/commons/data/${d.dataset_id}/versions/compare?to=${v.dataset_version_id}`} className={buttonClass("ghost", "sm")}>
                <GitCompareArrows aria-hidden="true" strokeWidth={1.75} />
                {t("compare")}
              </Link>
            ) : null}
            {v.status === "PUBLISHED" && canDownload ? (
              <Link href={`${href}?download=1`} className={buttonClass("ghost", "sm")}>
                <Download aria-hidden="true" strokeWidth={1.75} />
                {t("download")}
              </Link>
            ) : null}
            {action}
          </div>
        )}
      </div>
    </li>
  );
}

/** "버전 이름 규칙": the R12 minor/major guidance in a small popover. */
function LabelRule() {
  const t = useTranslations("data.versioning");
  return (
    <Popover>
      <PopoverTrigger className={buttonClass("ghost", "sm")}>{t("labelRule")}</PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <PopoverTitle>{t("labelRuleTitle")}</PopoverTitle>
        <ul className="mt-2 flex flex-col gap-1.5 text-small text-fg-muted">
          <li>{t("labelRuleMinor")}</li>
          <li>{t("labelRuleMajor")}</li>
          <li>{t("labelRuleFree")}</li>
        </ul>
      </PopoverContent>
    </Popover>
  );
}
