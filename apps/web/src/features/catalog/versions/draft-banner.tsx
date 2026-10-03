"use client";
import { Button, buttonClass, cn, Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle, Radio, RadioGroup } from "@nais/ui";
import { CircleCheck, GitCompareArrows, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import { asApiError } from "@/shared/api/errors";
import { useErrorText } from "@/shared/api/use-error-text";
import type { DatasetVersion } from "@/shared/api/types";
import { formatBytes } from "@/shared/lib/format";
import { notify } from "@/shared/ui/toast";
import { useListDatasetVersions } from "../api";
import { useDiscardDraft, useRebaseDraft, type RebaseResolutions } from "./api";

type Side = { size_bytes: number; sha256: string } | null;
export type RebaseConflict = {
  path: string;
  base: Side;
  mine: Side;
  theirs: Side;
};

/** Labels by id and the latest PUBLISHED version, from the dataset's version list (shared query). */
export function useVersionLine(datasetId: string) {
  const list = useListDatasetVersions(datasetId);
  const items = list.data?.items ?? [];
  const labels = new Map(items.map((v) => [v.dataset_version_id, v.version_label]));
  const latest =
    items
      .filter((v) => v.status === "PUBLISHED")
      .sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? "") || b.dataset_version_id.localeCompare(a.dataset_version_id))[0] ?? null;
  return { labels, latest, ready: !list.isPending };
}

function conflictsOf(error: unknown): RebaseConflict[] | null {
  const e = asApiError(error);
  if (e.code !== "CONFLICT") return null;
  const raw = e.details.conflicts;
  return Array.isArray(raw) ? raw.filter((c): c is RebaseConflict => !!c && typeof (c as RebaseConflict).path === "string") : null;
}

const mono = (c: ReactNode) => <span className="font-mono text-[12.5px] font-medium">{c}</span>;

/**
 * The draft's state as a panel under the version header (spec §3.3b): which version it builds on and, when a newer
 * version was published meanwhile, a plain explanation with "최신 기준으로 갱신" (rebase; conflicts open a dialog).
 * Also the draft's own actions: compare with the base and discard.
 */
export function DraftBanner({ version, datasetId }: { version: DatasetVersion; datasetId: string }) {
  const t = useTranslations("data.versioning");
  const errorText = useErrorText();
  const router = useRouter();
  const { labels, latest } = useVersionLine(datasetId);
  const rebase = useRebaseDraft(version.dataset_version_id);
  const discard = useDiscardDraft(datasetId);
  const [conflicts, setConflicts] = useState<RebaseConflict[] | null>(null);
  const [rebaseError, setRebaseError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);

  const stale = version.base_is_latest === false;
  const base = version.base_version_id ? (labels.get(version.base_version_id) ?? null) : null;
  const latestLabel = latest?.version_label ?? "…";
  const inherited = version.files.filter((f) => f.inherited).length;
  const own = version.files.length - inherited;

  const runRebase = (resolutions?: RebaseResolutions) => {
    setRebaseError(null);
    rebase.mutate(resolutions, {
      onSuccess: () => {
        setConflicts(null);
        notify.success(t("banner.rebased"));
      },
      onError: (e) => {
        const found = conflictsOf(e);
        if (found?.length) setConflicts(found);
        else {
          setConflicts(null);
          setRebaseError(asApiError(e).code === "CONFLICT" ? t("banner.rebaseBusy") : errorText(e));
        }
      },
    });
  };

  const title = stale ? t("banner.staleTitle", { latest: latestLabel }) : base ? t("banner.latestTitle") : t("banner.firstTitle");
  const body = stale ? t("banner.staleBody", { base: base ?? "…", latest: latestLabel }) : base ? t("banner.latestBody") : t("banner.firstBody");
  const Icon = stale ? TriangleAlert : CircleCheck;

  return (
    <section
      aria-label={t("banner.label")}
      className={cn(
        "grid grid-cols-1 gap-x-6 gap-y-3 rounded-md border px-4 py-4 sm:px-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-start",
        stale ? "border-warning-line bg-warning-soft" : "border-border bg-bg-panel",
      )}
    >
      <div className="flex min-w-0 gap-3">
        <Icon aria-hidden="true" strokeWidth={1.75} className={cn("mt-0.5 size-[18px] shrink-0", stale ? "text-warning" : "text-success")} />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="sv-kicker">{stale ? t("banner.staleKicker") : t("banner.kicker")}</p>
          <h2 className="break-keep text-[15.5px] font-bold leading-snug tracking-[-0.02em] text-fg">{title}</h2>
          <p className="max-w-[52em] break-keep text-small text-fg-muted [text-wrap:pretty]">{body}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-fg-muted">
            {base ? (
              <span>
                {t("banner.base")} {mono(base)}
              </span>
            ) : null}
            {base ? <span aria-hidden="true">·</span> : null}
            <span className="num">{t("banner.inheritedCount", { count: inherited })}</span>
            <span aria-hidden="true">·</span>
            <span className="num">{t("banner.ownCount", { count: own })}</span>
          </p>
          {rebaseError ? (
            <p role="alert" className="mt-1 text-small font-medium text-danger">
              {rebaseError}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-[30px] md:justify-end md:pl-0">
        {stale ? (
          <Button variant="primary" size="sm" loading={rebase.isPending && !conflicts} onClick={() => runRebase()}>
            <RefreshCw aria-hidden="true" strokeWidth={1.75} />
            {t("banner.rebase")}
          </Button>
        ) : null}
        {base ? (
          <Link href={`/commons/data/${datasetId}/versions/compare?to=${version.dataset_version_id}`} className={buttonClass("secondary", "sm")}>
            <GitCompareArrows aria-hidden="true" strokeWidth={1.75} />
            {t("banner.compare")}
          </Link>
        ) : null}
        <Button variant="ghost" size="sm" onClick={() => setDiscarding(true)}>
          <Trash2 aria-hidden="true" strokeWidth={1.75} />
          {t("banner.discard")}
        </Button>
      </div>

      <ConflictDialog conflicts={conflicts} pending={rebase.isPending} onOpenChange={(open) => !open && setConflicts(null)} onApply={(resolutions) => runRebase(resolutions)} />
      <DiscardDialog
        open={discarding}
        onOpenChange={setDiscarding}
        label={version.version_label}
        pending={discard.isPending}
        onConfirm={() =>
          discard.mutate(version.dataset_version_id, {
            onSuccess: () => {
              setDiscarding(false);
              notify.success(t("banner.discarded"));
              router.push(`/commons/data/${datasetId}?tab=versions`);
            },
            onError: (e) => {
              setDiscarding(false);
              notify.error(errorText(e));
            },
          })
        }
      />
    </section>
  );
}

function DiscardDialog({
  open,
  onOpenChange,
  label,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  label: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  const t = useTranslations("data.versioning.banner");
  const tc = useTranslations("common");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Destructive and irreversible: announced as an alert dialog. */}
      <DialogContent closeLabel={tc("close")} role="alertdialog">
        <DialogTitle>{t("discardTitle")}</DialogTitle>
        <DialogDescription className="break-keep">{t("discardBody", { label })}</DialogDescription>
        <DialogFooter>
          <DialogClose render={<Button variant="secondary" />}>{tc("cancel")}</DialogClose>
          <Button variant="danger" loading={pending} onClick={onConfirm}>
            {t("discardConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One row per conflicting path: base / mine / latest previews (size + short sha) and a required MINE / THEIRS choice. */
function ConflictDialog({
  conflicts,
  pending,
  onOpenChange,
  onApply,
}: {
  conflicts: RebaseConflict[] | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: (resolutions: RebaseResolutions) => void;
}) {
  const t = useTranslations("data.versioning.conflict");
  const tc = useTranslations("common");
  const [choices, setChoices] = useState<RebaseResolutions>({});
  const list = conflicts ?? [];
  const done = list.filter((c) => choices[c.path]).length;
  const complete = list.length > 0 && done === list.length;
  return (
    <Dialog
      open={!!conflicts}
      onOpenChange={(open) => {
        if (!open) setChoices({});
        onOpenChange(open);
      }}
    >
      <DialogContent closeLabel={tc("close")} size="md">
        <DialogTitle>{t("title")}</DialogTitle>
        <DialogDescription className="break-keep">{t("description")}</DialogDescription>
        <ul className="mt-4 flex flex-col divide-y divide-border border-y border-border">
          {list.map((c) => (
            <li key={c.path} className="flex flex-col gap-2 py-3">
              <p className="break-all font-mono text-[13px] font-semibold text-fg">{c.path}</p>
              <RadioGroup
                aria-label={c.path}
                value={choices[c.path] ?? ""}
                onValueChange={(v) =>
                  setChoices((s) => ({
                    ...s,
                    [c.path]: v === "THEIRS" ? "THEIRS" : "MINE",
                  }))
                }
                className="gap-1.5"
              >
                <SideRow label={<span className="pl-6 text-fg-muted">{t("base")}</span>} side={c.base} absent={t("absent")} />
                <SideRow label={<Radio value="MINE" label={t("keepMine")} />} side={c.mine} absent={t("absent")} />
                <SideRow label={<Radio value="THEIRS" label={t("takeTheirs")} />} side={c.theirs} absent={t("absent")} />
              </RadioGroup>
            </li>
          ))}
        </ul>
        <DialogFooter className="items-center">
          <span className="mr-auto text-small text-fg-muted num" aria-live="polite">
            {t("progress", { done, total: list.length })}
          </span>
          <DialogClose render={<Button variant="secondary" />}>{tc("cancel")}</DialogClose>
          <Button variant="primary" loading={pending} disabled={!complete || pending} onClick={() => onApply(choices)}>
            {t("apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SideRow({ label, side, absent }: { label: ReactNode; side: Side; absent: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 text-small sm:grid-cols-[minmax(0,1fr)_6rem_5.5rem]">
      <span className="min-w-0">{label}</span>
      {side ? (
        <>
          <span className="num hidden text-right text-fg-muted sm:block">{formatBytes(side.size_bytes)}</span>
          <span className="text-right font-mono text-[12.5px] text-fg" title={side.sha256}>
            <span className="sm:hidden text-fg-muted">{formatBytes(side.size_bytes)} · </span>
            {side.sha256.slice(0, 8)}
          </span>
        </>
      ) : (
        <span className="text-right text-fg-muted sm:col-span-2">{absent}</span>
      )}
    </div>
  );
}
