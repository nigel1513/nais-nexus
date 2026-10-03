"use client";
import { cn, IconButton, Skeleton } from "@nais/ui";
import { X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useErrorText } from "@/shared/api/use-error-text";
import { formatBytes } from "@/shared/lib/format";
import { DateTime } from "@/shared/ui/date-text";
import { useFileHistory, type FileHistory } from "./api";

type Entry = FileHistory["items"][number];

/** Glyph + text per state: the colour only repeats what the glyph and label already say. */
const MARK: Record<Entry["state"], { glyph: string; tone: string }> = {
  ADDED: { glyph: "+", tone: "border-success-solid text-success" },
  CHANGED: { glyph: "~", tone: "border-warning-solid text-warning" },
  REMOVED: { glyph: "−", tone: "border-danger-solid text-danger" },
  UNCHANGED: { glyph: "=", tone: "border-border-strong text-fg-muted" },
  ABSENT: { glyph: "·", tone: "border-border text-fg-subtle" },
};

/**
 * "파일 이력" (spec §3.3b R10): one path across every published version, newest first. Each step says whether that
 * version added, changed, kept (= inherited, drawn as a dashed span) or removed the file, with its size and short sha.
 */
export function FileHistoryPanel({ datasetId, path, compared = [], onClose }: { datasetId: string; path: string; compared?: string[]; onClose: () => void }) {
  const t = useTranslations("data.versioning");
  const te = useTranslations("enums.FileChangeStatus");
  const errorText = useErrorText();
  const history = useFileHistory(datasetId, path);
  const items = [...(history.data?.items ?? [])].reverse();

  return (
    <section aria-label={t("fileHistory.title")} className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-bg-panel p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="sv-kicker">{t("fileHistory.title")}</p>
          <p className="break-all font-mono text-[13px] font-semibold text-fg">{path}</p>
        </div>
        <IconButton label={t("fileHistory.close")} variant="ghost" size="sm" onClick={onClose}>
          <X aria-hidden="true" strokeWidth={1.75} />
        </IconButton>
      </div>
      {history.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : history.isError ? (
        <p role="alert" className="text-small text-danger">
          {errorText(history.error)}
        </p>
      ) : items.length === 0 ? (
        <p className="text-small text-fg-muted">{t("fileHistory.empty")}</p>
      ) : (
        <ol className="flex flex-col">
          {items.map((e, i) => {
            const mark = MARK[e.state];
            const last = i === items.length - 1;
            // The line below a step leads to the older version: dashed while the file only rides along (inherited).
            const inheritedSpan = e.state === "UNCHANGED";
            return (
              <li key={e.dataset_version_id} data-state={e.state} className="relative grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3 pb-4 last:pb-0">
                {!last ? (
                  <span aria-hidden="true" className={cn("absolute bottom-0 left-[0.6875rem] top-6 w-0 border-l", inheritedSpan ? "border-dashed border-border-strong" : "border-border")} />
                ) : null}
                <span aria-hidden="true" className={cn("relative z-[1] mt-0.5 flex size-6 items-center justify-center rounded-full border bg-bg-panel font-mono text-[13px] font-semibold", mark.tone)}>
                  {mark.glyph}
                </span>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small">
                    <Link
                      href={`/commons/data/${datasetId}/versions/${e.dataset_version_id}`}
                      className="rounded-xs font-mono text-[12.5px] font-semibold text-fg underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-focus"
                    >
                      {e.version_label}
                    </Link>
                    <span className="font-medium text-fg">{e.state === "ABSENT" ? t("fileHistory.absent") : te(e.state)}</span>
                    {inheritedSpan ? <span className="rounded-xs border border-border px-1.5 text-caption text-fg-muted">{t("fileHistory.inherited")}</span> : null}
                    {compared.includes(e.dataset_version_id) ? <span className="rounded-xs bg-accent-soft px-1.5 text-caption font-semibold text-accent-fg">{t("fileHistory.inCompare")}</span> : null}
                  </p>
                  <p className="flex flex-wrap items-center gap-x-2 text-caption text-fg-muted">
                    {e.size_bytes !== null && e.size_bytes !== undefined ? <span className="num">{formatBytes(e.size_bytes)}</span> : null}
                    {e.sha256 ? (
                      <span className="font-mono" title={e.sha256}>
                        {e.sha256.slice(0, 8)}
                      </span>
                    ) : null}
                    <span className="num">
                      <DateTime value={e.published_at} dateOnly />
                    </span>
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
