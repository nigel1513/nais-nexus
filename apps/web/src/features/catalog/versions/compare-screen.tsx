"use client";
import { Button, Checkbox, cn, EmptyState, IconButton, Label, Select, Table, TBody, Td, Th, THead, Tr, Tabs, TabsContent, TabsList, TabsTrigger } from "@nais/ui";
import { ArrowLeftRight, History } from "lucide-react";
import { useTranslations } from "next-intl";
import { Fragment, useId, useState, type ReactNode } from "react";
import type { DatasetVersion, Schemas } from "@/shared/api/types";
import { useMediaQuery } from "@/shared/hooks/use-media-query";
import { ApiError } from "@/shared/api/errors";
import { useUrlQuery } from "@/shared/hooks/use-url-query";
import { formatBytes } from "@/shared/lib/format";
import { useBreadcrumbs } from "@/shared/ui/breadcrumbs";
import { SummaryBand } from "@/shared/ui/screen-v2";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { useGetDataset, useListDatasetVersions } from "../api";
import { useCompareVersions, type VersionDiff } from "./api";
import { FileHistoryPanel } from "./file-history-panel";
import { wordDiff } from "./word-diff";

type FileChange = Schemas["FileChange"];
type Status = FileChange["status"];
const LAYERS = ["files", "schema", "metadata"] as const;
type Layer = (typeof LAYERS)[number];

/** Status marks: a glyph and a text label always, the status colour only as a third cue (never alone). */
const GLYPH: Record<Status, string> = { ADDED: "+", REMOVED: "−", CHANGED: "~", UNCHANGED: "=" };
const TEXT_TONE: Record<Status, string> = { ADDED: "text-success", REMOVED: "text-danger", CHANGED: "text-warning", UNCHANGED: "text-fg-muted" };
const FILL: Record<Status, string> = { ADDED: "bg-success-solid", REMOVED: "bg-danger-solid", CHANGED: "bg-warning-solid", UNCHANGED: "bg-border-strong" };
const ORDER: Status[] = ["ADDED", "REMOVED", "CHANGED", "UNCHANGED"];
const nf = new Intl.NumberFormat("ko-KR");
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 8) : null);
const byNewest = (a: DatasetVersion, b: DatasetVersion) => (b.published_at ?? b.created_at).localeCompare(a.published_at ?? a.created_at);

/**
 * "버전 비교" (spec §3.3b R11): two versions of one dataset side by side in three layers — files (path tree, status,
 * size and sha deltas, per-file history), data structure (row counts and column changes from the profiles, never values)
 * and metadata (field by field, long text as a word diff). `to` / `from` live in the URL so a comparison can be shared;
 * without `from` the server compares with the previous version (a draft: its base).
 */
export function CompareScreen({ datasetId, to: toProp, from: fromProp }: { datasetId: string; to?: string; from?: string }) {
  const t = useTranslations("data.versioning");
  const [params, setParams] = useUrlQuery();
  const ds = useGetDataset(datasetId);
  const versions = useListDatasetVersions(datasetId);
  const items = [...(versions.data?.items ?? [])].sort(byNewest);
  const latest = items.find((v) => v.status === "PUBLISHED");
  const to = params.get("to") ?? toProp ?? latest?.dataset_version_id ?? "";
  const from = params.get("from") ?? fromProp ?? undefined;
  // Both ends must be versions of this dataset the viewer can see; anything else is "not found", never fetched.
  const known = new Set(items.map((v) => v.dataset_version_id));
  const foreign = versions.isSuccess && ((!!to && !known.has(to)) || (!!from && !known.has(from)));
  const diff = useCompareVersions(to, from, { enabled: !!to && versions.isSuccess && !foreign });
  const labels = new Map(items.map((v) => [v.dataset_version_id, v.version_label]));
  const layer: Layer = LAYERS.includes(params.get("layer") as Layer) ? (params.get("layer") as Layer) : "files";
  const historyPath = params.get("file");
  useBreadcrumbs([...(ds.data ? [{ label: ds.data.title, href: `/commons/data/${datasetId}?tab=versions` }] : []), { label: t("diff.crumb") }]);

  if (ds.isPending || versions.isPending || (to && !foreign && diff.isPending)) return <DelayedSkeleton lines={8} />;
  if (ds.isError) return <ErrorView error={ds.error} onRetry={() => void ds.refetch()} />;
  if (versions.isError) return <ErrorView error={versions.error} onRetry={() => void versions.refetch()} />;
  if (foreign) return <ErrorView error={new ApiError(404, "NOT_FOUND", "Version not in this dataset", null)} />;
  if (diff.isError) return <ErrorView error={diff.error} onRetry={() => void diff.refetch()} />;
  if (!diff.data) return <EmptyState title={t("empty")} />;

  const d = diff.data;
  const toLabel = labels.get(d.to_version_id) ?? "?";
  const fromLabel = d.from_version_id ? (labels.get(d.from_version_id) ?? "?") : null;
  const toVersion = items.find((v) => v.dataset_version_id === d.to_version_id);
  const s = d.summary;

  return (
    <>
      <SummaryBand
        label={t("diff.summaryLabel")}
        context={[ds.data.title, t("diff.context")]}
        title={fromLabel ? `${fromLabel} → ${toLabel}` : t("diff.first", { to: toLabel })}
        tags={<SummaryLine summary={s} />}
        facts={[
          { label: t("diff.from"), value: fromLabel ?? "—", kind: "mono" },
          { label: t("diff.to"), value: toLabel, kind: "mono" },
          { label: t("diff.files"), value: nf.format(s.added + s.removed + s.changed + s.unchanged) },
          { label: t("diff.bar"), value: <StackBar summary={s} onDark />, kind: "text" },
        ]}
      />
      <div className="flex flex-col gap-6">
        <Pickers
          items={items}
          to={d.to_version_id}
          from={from ?? ""}
          fromLabel={toVersion?.status === "DRAFT" ? t("diff.defaultFromDraft") : t("diff.defaultFrom")}
          resolvedFrom={d.from_version_id}
          onChange={(patch) => setParams({ ...patch, file: null })}
        />
        {!d.from_version_id ? <p className="break-keep text-small text-fg-muted">{t("diff.firstNote")}</p> : null}
        <Tabs value={layer} onValueChange={(v) => setParams({ layer: v === "files" ? null : v })}>
          <TabsList aria-label={t("diff.pick")}>
            <TabsTrigger value="files" count={s.added + s.removed + s.changed}>
              {t("diff.files")}
            </TabsTrigger>
            <TabsTrigger value="schema" count={d.schema.filter(schemaChanged).length}>
              {t("diff.schema")}
            </TabsTrigger>
            <TabsTrigger value="metadata" count={d.metadata.length}>
              {t("diff.metadata")}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="files">
            <div className={cn("grid grid-cols-1 gap-6", historyPath ? "xl:grid-cols-12" : null)}>
              <div className={historyPath ? "min-w-0 xl:col-span-8" : "min-w-0"}>
                <FilesLayer key={`${d.from_version_id ?? ""}>${d.to_version_id}`} diff={d} onHistory={(path) => setParams({ file: path })} />
              </div>
              {historyPath ? (
                <div className="min-w-0 xl:col-span-4">
                  <div className="xl:sticky xl:top-20">
                    <FileHistoryPanel datasetId={datasetId} path={historyPath} compared={[d.to_version_id, ...(d.from_version_id ? [d.from_version_id] : [])]} onClose={() => setParams({ file: null })} />
                  </div>
                </div>
              ) : null}
            </div>
          </TabsContent>
          <TabsContent value="schema">
            <SchemaLayer diff={d} />
          </TabsContent>
          <TabsContent value="metadata">
            <MetadataLayer diff={d} />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}

function SummaryLine({ summary: s }: { summary: Schemas["ChangeSummary"] }) {
  const t = useTranslations("data.versioning.diff");
  return (
    <span className="sv-tag gap-2 border-0 px-0 text-[13px] font-medium text-hero-fg">
      <span>{t("summary", s)}</span>
      <span aria-hidden="true" className="text-hero-fg-muted">
        ·
      </span>
      <span className="text-hero-fg-muted">{t("unchangedCount", { count: s.unchanged })}</span>
    </span>
  );
}

/**
 * Share of files by status as one stacked bar (dataviz: part-to-whole, status hues in fixed order, 2px gaps between
 * segments, 4px rounded ends); the counts sit beside it in text, and each segment carries its sentence as a title.
 */
function StackBar({ summary: s, onDark }: { summary: Schemas["ChangeSummary"]; onDark?: boolean }) {
  const t = useTranslations("data.versioning.diff");
  const te = useTranslations("enums.FileChangeStatus");
  const counts: Record<Status, number> = { ADDED: s.added, REMOVED: s.removed, CHANGED: s.changed, UNCHANGED: s.unchanged };
  const total = ORDER.reduce((n, k) => n + counts[k], 0);
  return (
    <span className="flex min-w-0 flex-col gap-1.5 pt-1.5">
      <span role="img" aria-label={`${t("bar")}: ${ORDER.map((k) => `${te(k)} ${counts[k]}`).join(", ")}`} className="flex h-2.5 w-full gap-[2px]">
        {total === 0 ? <span className={cn("h-full flex-1 rounded-[4px]", onDark ? "bg-hero-fg/15" : "bg-border")} /> : null}
        {ORDER.filter((k) => counts[k] > 0).map((k) => (
          <span key={k} title={`${te(k)} ${counts[k]}`} style={{ flexGrow: counts[k] }} className={cn("h-full min-w-1 basis-0 first:rounded-l-[4px] last:rounded-r-[4px]", k === "UNCHANGED" && onDark ? "bg-hero-fg/25" : FILL[k])} />
        ))}
      </span>
      <span aria-hidden="true" className={cn("flex flex-wrap gap-x-2.5 font-mono text-[12px] font-medium leading-none", onDark ? "text-hero-fg-muted" : "text-fg-muted")}>
        {ORDER.map((k) => (
          <span key={k} className="inline-flex items-center gap-1">
            <span className={cn("size-2 rounded-[2px]", k === "UNCHANGED" && onDark ? "bg-hero-fg/25" : FILL[k])} />
            {GLYPH[k]}
            {counts[k]}
          </span>
        ))}
      </span>
    </span>
  );
}

function Pickers({
  items,
  to,
  from,
  fromLabel,
  resolvedFrom,
  onChange,
}: {
  items: DatasetVersion[];
  to: string;
  from: string;
  fromLabel: string;
  resolvedFrom: string | null | undefined;
  onChange: (patch: Record<string, string | null>) => void;
}) {
  const t = useTranslations("data.versioning");
  const fromId = useId();
  const toId = useId();
  const name = (v: DatasetVersion) => (v.status === "DRAFT" ? `${v.version_label} (${t("diff.draft")})` : v.version_label);
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex w-full flex-col gap-1.5 sm:w-56">
        <Label htmlFor={fromId}>{t("diff.from")}</Label>
        <Select id={fromId} value={from} onChange={(e) => onChange({ from: e.target.value || null })} className="font-mono">
          <option value="">{fromLabel}</option>
          {items
            .filter((v) => v.dataset_version_id !== to)
            .map((v) => (
              <option key={v.dataset_version_id} value={v.dataset_version_id}>
                {name(v)}
              </option>
            ))}
        </Select>
      </div>
      <IconButton
        label={t("diff.swap")}
        variant="secondary"
        disabled={!resolvedFrom}
        className="max-sm:hidden"
        onClick={() => resolvedFrom && onChange({ from: to, to: resolvedFrom })}
      >
        <ArrowLeftRight aria-hidden="true" strokeWidth={1.75} />
      </IconButton>
      <div className="flex w-full flex-col gap-1.5 sm:w-56">
        <Label htmlFor={toId}>{t("diff.to")}</Label>
        <Select id={toId} value={to} onChange={(e) => onChange({ to: e.target.value, from: null })} className="font-mono">
          {items.map((v) => (
            <option key={v.dataset_version_id} value={v.dataset_version_id}>
              {name(v)}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}

function StatusMark({ status }: { status: Status }) {
  const te = useTranslations("enums.FileChangeStatus");
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden="true" className={cn("w-3 text-center font-mono font-semibold", TEXT_TONE[status])}>
        {GLYPH[status]}
      </span>
      <span className={status === "UNCHANGED" ? "text-fg-muted" : "text-fg"}>{te(status)}</span>
    </span>
  );
}

const signedBytes = (n: number) => (n === 0 ? "0" : `${n > 0 ? "+" : "−"}${formatBytes(Math.abs(n))}`);

/** Size change as a bar from a centre rule (grows right, shrinks left), scaled to the largest change on the page. */
function DeltaBar({ delta, max }: { delta: number; max: number }) {
  const share = max > 0 ? Math.max(Math.abs(delta) / max, delta === 0 ? 0 : 0.06) : 0;
  return (
    <span aria-hidden="true" className="relative inline-block h-2 w-14 shrink-0">
      <span className="absolute inset-y-[-2px] left-1/2 w-px bg-border-strong" />
      {delta !== 0 ? (
        <span
          className={cn("absolute inset-y-0 rounded-[2px] bg-fg-muted/55", delta > 0 ? "left-1/2 ml-px" : "right-1/2 mr-px")}
          style={{ width: `calc(${(share * 50).toFixed(2)}% - 1px)` }}
        />
      ) : null}
    </span>
  );
}

/** Rows shown per directory before "더 보기": keeps a 3,000-file diff quick to render. */
export const DIR_PAGE = 200;

function FilesLayer({ diff: d, onHistory }: { diff: VersionDiff; onHistory: (path: string) => void }) {
  const t = useTranslations("data.versioning.diff");
  const changes = d.summary.added + d.summary.removed + d.summary.changed;
  const [changedOnly, setChangedOnly] = useState(changes > 0);
  const [shown, setShown] = useState<Record<string, number>>({});
  const phone = useMediaQuery("(max-width: 767px)");
  const checkId = useId();
  const rows = changedOnly ? d.files.filter((f) => f.status !== "UNCHANGED") : d.files;
  let max = 0;
  for (const f of rows) max = Math.max(max, Math.abs(f.size_delta));
  // Path tree: files grouped under their directory in one pass (the API lists them in path order).
  const groups = new Map<string, FileChange[]>();
  for (const f of rows) {
    const cut = f.path.lastIndexOf("/");
    const dir = cut >= 0 ? f.path.slice(0, cut + 1) : "";
    const list = groups.get(dir);
    if (list) list.push(f);
    else groups.set(dir, [f]);
  }
  const dirs = [...groups.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
  const visible = (dir: string) => groups.get(dir)!.slice(0, shown[dir] ?? DIR_PAGE);
  const more = (dir: string) => {
    const rest = groups.get(dir)!.length - (shown[dir] ?? DIR_PAGE);
    return rest > 0 ? (
      <Button variant="ghost" size="sm" onClick={() => setShown((s) => ({ ...s, [dir]: (s[dir] ?? DIR_PAGE) + DIR_PAGE }))}>
        {t("more", { dir: dir || "/", count: rest })}
      </Button>
    ) : null;
  };
  const historyButton = (f: FileChange, compact: boolean) =>
    compact ? (
      <IconButton label={t("historyFor", { path: f.path })} variant="ghost" size="sm" onClick={() => onHistory(f.path)}>
        <History aria-hidden="true" strokeWidth={1.75} />
      </IconButton>
    ) : (
      <Button variant="ghost" size="sm" aria-label={t("historyFor", { path: f.path })} onClick={() => onHistory(f.path)}>
        <History aria-hidden="true" strokeWidth={1.75} />
        {t("history")}
      </Button>
    );

  return (
    <section aria-label={t("files")} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 text-small text-fg">
          <Checkbox id={checkId} checked={changedOnly} onChange={(e) => setChangedOnly(e.target.checked)} />
          <label htmlFor={checkId} className="cursor-pointer select-none">
            {t("changedOnly")}
          </label>
        </span>
        <StackBar summary={d.summary} />
      </div>
      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border">
          <EmptyState title={t("noChanges")} description={t("noChangesHint")} />
        </div>
      ) : phone ? (
        // Phones: one compact row per file (the five-column table would only scroll sideways there).
        <ul aria-label={t("fileTable")} className="flex flex-col divide-y divide-border rounded-md border border-border bg-bg-panel">
          {dirs.map((dir) => (
            <Fragment key={dir || "/"}>
              {visible(dir).map((f) => (
                <li key={f.path} className="flex items-start justify-between gap-3 px-3.5 py-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className={cn("break-all font-mono text-[12.5px]", f.status === "REMOVED" ? "text-fg-muted line-through decoration-danger/60" : "text-fg")}>{f.path}</span>
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-small">
                      <StatusMark status={f.status} />
                      <span className="font-mono text-[12px] text-fg-muted">
                        {formatBytes((f.after ?? f.before)!.size_bytes)} <span className={f.size_delta ? "text-fg" : undefined}>({signedBytes(f.size_delta)})</span>
                      </span>
                    </span>
                  </div>
                  {historyButton(f, true)}
                </li>
              ))}
              {more(dir) ? <li className="px-2 py-1.5">{more(dir)}</li> : null}
            </Fragment>
          ))}
        </ul>
      ) : (
        <Table caption={t("fileTable")} className="font-normal">
          <THead>
            <Tr>
              <Th>{t("path")}</Th>
              <Th>{t("status")}</Th>
              <Th className="text-right">{t("size")}</Th>
              <Th>{t("sha")}</Th>
              <Th>
                <span className="sr-only">{t("history")}</span>
              </Th>
            </Tr>
          </THead>
          <TBody>
            {dirs.map((dir) => (
              <Fragment key={dir || "/"}>
                {dir ? (
                  <Tr className="bg-bg-subtle/60">
                    <Td colSpan={5} className="py-1.5 font-mono text-[12px] font-medium text-fg-muted">
                      {dir} <span className="num font-sans text-caption text-fg-muted">· {groups.get(dir)!.length}</span>
                    </Td>
                  </Tr>
                ) : null}
                {visible(dir).map((f) => (
                  <Tr key={f.path}>
                    <Td className={cn("font-mono text-[12.5px]", dir ? "pl-7" : null, f.status === "REMOVED" ? "text-fg-muted line-through decoration-danger/60" : "text-fg")}>
                      <span className="break-all">{dir ? f.path.slice(dir.length) : f.path}</span>
                    </Td>
                    <Td>
                      <StatusMark status={f.status} />
                    </Td>
                    <Td className="text-right">
                      <span className="inline-flex items-center justify-end gap-2.5 whitespace-nowrap font-mono text-[12px]">
                        <span className="text-fg-muted">
                          {f.before && f.after && f.status !== "UNCHANGED" ? `${formatBytes(f.before.size_bytes)} → ` : null}
                          <span className="text-fg">{formatBytes((f.after ?? f.before)!.size_bytes)}</span>
                        </span>
                        <span className={cn("w-[4.5rem] text-right", f.size_delta === 0 ? "text-fg-muted" : "text-fg")}>{signedBytes(f.size_delta)}</span>
                        <DeltaBar delta={f.size_delta} max={max} />
                      </span>
                    </Td>
                    <Td className="whitespace-nowrap font-mono text-[12px]">
                      {f.status === "CHANGED" ? (
                        <>
                          <span className="text-fg-muted" title={f.before!.sha256}>
                            {short(f.before!.sha256)}
                          </span>
                          <span className="px-1 text-fg-muted">→</span>
                          <span className="text-fg" title={f.after!.sha256}>
                            {short(f.after!.sha256)}
                          </span>
                        </>
                      ) : (
                        <span className={f.status === "UNCHANGED" ? "text-fg-muted" : "text-fg"} title={(f.after ?? f.before)!.sha256}>
                          {short((f.after ?? f.before)!.sha256)}
                        </span>
                      )}
                    </Td>
                    <Td className="text-right">{historyButton(f, false)}</Td>
                  </Tr>
                ))}
                {more(dir) ? (
                  <Tr>
                    <Td colSpan={5} className={dir ? "pl-5" : undefined}>
                      {more(dir)}
                    </Td>
                  </Tr>
                ) : null}
              </Fragment>
            ))}
          </TBody>
        </Table>
      )}
    </section>
  );
}

type SchemaChange = Schemas["SchemaChange"];
const schemaChanged = (c: SchemaChange) =>
  c.status === "PROFILE_MISSING" || (c.rows && c.rows[0] !== c.rows[1]) || !!c.columns_added?.length || !!c.columns_removed?.length || !!c.columns_changed?.length;
const pct = (r: number) => `${(r * 100).toFixed(1)}%`;

function Pair({ before, after, render = (v) => String(v) }: { before: unknown; after: unknown; render?: (v: unknown) => ReactNode }) {
  const same = JSON.stringify(before) === JSON.stringify(after);
  if (same) return <span className="text-fg-muted">{before === null || before === undefined ? "—" : render(before)}</span>;
  return (
    <span className="whitespace-nowrap">
      <span className="text-fg-muted">{before === null || before === undefined ? "—" : render(before)}</span>
      <span className="px-1 text-fg-muted">→</span>
      <span className="text-fg">{after === null || after === undefined ? "—" : render(after)}</span>
    </span>
  );
}

function SchemaLayer({ diff: d }: { diff: VersionDiff }) {
  const t = useTranslations("data.versioning.diff");
  if (d.schema.length === 0)
    return (
      <div className="rounded-md border border-dashed border-border">
        <EmptyState title={t("noSchema")} description={t("noSchemaHint")} />
      </div>
    );
  return (
    <div className="flex flex-col divide-y divide-border border-y border-border">
      {d.schema.map((c) => (
        <SchemaBlock key={c.path} change={c} />
      ))}
    </div>
  );
}

function SchemaBlock({ change: c }: { change: SchemaChange }) {
  const t = useTranslations("data.versioning.diff");
  const id = useId();
  const [before, after] = c.rows ?? [null, null];
  const delta = typeof before === "number" && typeof after === "number" ? after - before : null;
  const added = c.columns_added ?? [];
  const removed = c.columns_removed ?? [];
  const changed = c.columns_changed ?? [];
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 py-4">
      <h3 id={id} className="break-all font-mono text-[13px] font-semibold text-fg">
        {c.path}
      </h3>
      {c.status === "PROFILE_MISSING" ? (
        <p className="text-small text-fg-muted">{t("profileMissing")}</p>
      ) : (
        <>
          <p className="flex flex-wrap items-baseline gap-x-2 text-small">
            <span className="text-fg-muted">{t("rows")}</span>
            <span className="font-mono text-[13px] text-fg-muted">{typeof before === "number" ? nf.format(before) : t("rowsUnknown")}</span>
            <span className="text-fg-muted">→</span>
            <span className="font-mono text-[13px] font-semibold text-fg">{typeof after === "number" ? nf.format(after) : t("rowsUnknown")}</span>
            {delta !== null && delta !== 0 ? <span className="font-mono text-[12.5px] text-fg">({delta > 0 ? "+" : "−"}{nf.format(Math.abs(delta))})</span> : null}
          </p>
          {added.length || removed.length ? (
            <div className="flex flex-wrap items-center gap-1.5 text-small">
              {added.map((name) => (
                <span key={`+${name}`} className="inline-flex items-center gap-1 rounded-xs border border-success-line bg-success-soft px-1.5 font-mono text-[12px] text-fg">
                  <span aria-hidden="true" className="text-success">
                    +
                  </span>
                  <span className="sr-only">{t("columnsAdded")}: </span>
                  {name}
                </span>
              ))}
              {removed.map((name) => (
                <span key={`-${name}`} className="inline-flex items-center gap-1 rounded-xs border border-danger-line bg-danger-soft px-1.5 font-mono text-[12px] text-fg line-through decoration-danger/60">
                  <span aria-hidden="true" className="text-danger no-underline">
                    −
                  </span>
                  <span className="sr-only">{t("columnsRemoved")}: </span>
                  {name}
                </span>
              ))}
            </div>
          ) : null}
          {changed.length ? (
            <Table caption={`${c.path} ${t("columnsChanged")}`}>
              <THead>
                <Tr>
                  <Th>{t("column")}</Th>
                  <Th>{t("type")}</Th>
                  <Th>{t("unit")}</Th>
                  <Th className="text-right">{t("missing")}</Th>
                </Tr>
              </THead>
              <TBody>
                {changed.map((col) => {
                  const [mb, ma] = col.missing_ratio ?? [null, null];
                  const pp = typeof mb === "number" && typeof ma === "number" ? (ma - mb) * 100 : null;
                  return (
                    <Tr key={col.name}>
                      <Td className="font-mono text-[12.5px] text-fg">{col.name}</Td>
                      <Td className="font-mono text-[12px]">{col.type ? <Pair before={col.type[0]} after={col.type[1]} /> : <span className="text-fg-muted">—</span>}</Td>
                      <Td className="font-mono text-[12px]">{col.unit ? <Pair before={col.unit[0]} after={col.unit[1]} /> : <span className="text-fg-muted">—</span>}</Td>
                      <Td className="text-right font-mono text-[12px]">
                        {col.missing_ratio ? (
                          <>
                            <Pair before={mb} after={ma} render={(v) => pct(v as number)} />
                            {pp !== null && pp !== 0 ? <span className="pl-1.5 text-fg">({pp > 0 ? "+" : "−"}{Math.abs(pp).toFixed(1)}%p)</span> : null}
                          </>
                        ) : (
                          <span className="text-fg-muted">—</span>
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
          ) : !added.length && !removed.length ? (
            <p className="text-small text-fg-muted">{t("schemaSame")}</p>
          ) : null}
        </>
      )}
    </section>
  );
}

// ---- metadata layer -----------------------------------------------------------------------------------------------
const LONG_TEXT = new Set(["description", "provenance", "usage_policy", "method_detail"]);
const ENUM_OF: Record<string, string> = { access_level: "AccessLevel", update_frequency: "UpdateFrequency", allowed_purposes: "Purpose" };
type Person = { display_name?: string; affiliation?: { name?: string | null } | null };
const isPerson = (v: unknown): v is Person => typeof v === "object" && v !== null && "display_name" in v;

function MetadataLayer({ diff: d }: { diff: VersionDiff }) {
  const t = useTranslations("data.versioning.diff");
  const tf = useTranslations("data.versioning.fields");
  const tr = useTranslations();
  if (d.metadata.length === 0)
    return (
      <div className="rounded-md border border-dashed border-border">
        <EmptyState title={t("noMetadata")} />
      </div>
    );
  const label = (field: string) => {
    const key = field.replace(/\./g, "_");
    return tf.has(key) ? tf(key) : field;
  };
  const one = (field: string, v: unknown): string => {
    if (v === null || v === undefined || v === "") return t("empty");
    if (isPerson(v)) return v.affiliation?.name ? `${v.display_name} (${v.affiliation.name})` : String(v.display_name);
    if (typeof v === "object" && v !== null && "title" in v) return String((v as { title: unknown }).title);
    const e = ENUM_OF[field];
    if (e && typeof v === "string" && tr.has(`enums.${e}.${v}`)) return tr(`enums.${e}.${v}`);
    return typeof v === "string" ? v : JSON.stringify(v);
  };
  return (
    <Table caption={t("metadata")}>
      <THead>
        <Tr>
          <Th className="w-[11rem]">{t("field")}</Th>
          <Th>{t("before")}</Th>
          <Th>{t("after")}</Th>
        </Tr>
      </THead>
      <TBody>
        {d.metadata.map((m) => {
          const head = (
            <Td className="align-top">
              <span className="flex flex-col gap-0.5">
                <span className="font-medium text-fg">{label(m.field)}</span>
                <span className="font-mono text-[11.5px] text-fg-muted">{m.field}</span>
              </span>
            </Td>
          );
          if (LONG_TEXT.has(m.field) && (typeof m.before === "string" || m.before === null) && (typeof m.after === "string" || m.after === null)) {
            const runs = wordDiff(m.before ?? "", m.after ?? "");
            if (runs)
              return (
                <Tr key={m.field}>
                  {head}
                  <Td colSpan={2} className="align-top">
                    <p className="whitespace-pre-wrap break-words text-small leading-relaxed text-fg [text-wrap:pretty]">
                      {runs.map((r, i) =>
                        r.kind === "same" ? (
                          <span key={i}>{r.text}</span>
                        ) : r.kind === "removed" ? (
                          <del key={i} className="mr-0.5 rounded-[2px] bg-danger-soft text-fg-muted decoration-danger/70">
                            <span className="sr-only">[{t("removedText")}: </span>
                            {r.text}
                            <span className="sr-only">]</span>
                          </del>
                        ) : (
                          <ins key={i} className="rounded-[2px] bg-success-soft text-fg underline decoration-success/70 underline-offset-2">
                            <span className="sr-only">[{t("addedText")}: </span>
                            {r.text}
                            <span className="sr-only">]</span>
                          </ins>
                        ),
                      )}
                    </p>
                  </Td>
                </Tr>
              );
            // Too long to diff word by word: both texts whole, and say so.
            return (
              <Tr key={m.field}>
                {head}
                <Td className="align-top">
                  <p className="whitespace-pre-wrap break-words text-small text-fg-muted">{m.before ?? t("empty")}</p>
                </Td>
                <Td className="align-top">
                  <p className="mb-1.5 text-caption text-fg-muted">{t("tooLong")}</p>
                  <p className="whitespace-pre-wrap break-words text-small text-fg">{m.after ?? t("empty")}</p>
                </Td>
              </Tr>
            );
          }
          if (Array.isArray(m.before) || Array.isArray(m.after)) {
            const b = ((m.before as unknown[] | null) ?? []).map((v) => one(m.field, v));
            const a = ((m.after as unknown[] | null) ?? []).map((v) => one(m.field, v));
            const list = (values: string[], other: string[], side: "before" | "after") =>
              values.length === 0 ? (
                <span className="text-fg-muted">{t("empty")}</span>
              ) : (
                <span className="flex flex-wrap gap-1">
                  {values.map((v) => {
                    const gone = side === "before" && !other.includes(v);
                    const fresh = side === "after" && !other.includes(v);
                    return (
                      <span
                        key={v}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-xs border px-1.5 text-[12.5px]",
                          gone ? "border-danger-line bg-danger-soft text-fg-muted line-through decoration-danger/60" : fresh ? "border-success-line bg-success-soft text-fg" : "border-border text-fg-muted",
                        )}
                      >
                        {gone ? <span aria-hidden="true" className="text-danger no-underline">−</span> : fresh ? <span aria-hidden="true" className="text-success">+</span> : null}
                        {gone ? <span className="sr-only">{t("removedText")}: </span> : fresh ? <span className="sr-only">{t("addedText")}: </span> : null}
                        {v}
                      </span>
                    );
                  })}
                </span>
              );
            return (
              <Tr key={m.field}>
                {head}
                <Td className="align-top">{list(b, a, "before")}</Td>
                <Td className="align-top">{list(a, b, "after")}</Td>
              </Tr>
            );
          }
          const mono = m.field === "license" || m.field.endsWith("_id") || m.field.startsWith("temporal_") || m.field === "project_code";
          return (
            <Tr key={m.field}>
              {head}
              <Td className={cn("align-top text-fg-muted", mono ? "font-mono text-[12.5px]" : null)}>
                <span className={m.before === null || m.before === "" ? undefined : "line-through decoration-danger/50"}>{one(m.field, m.before)}</span>
              </Td>
              <Td className={cn("align-top text-fg", mono ? "font-mono text-[12.5px]" : null)}>{one(m.field, m.after)}</Td>
            </Tr>
          );
        })}
      </TBody>
    </Table>
  );
}

