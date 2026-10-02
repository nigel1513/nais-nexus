"use client";
import { Button, cn, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, FormField, Input, Radio, RadioGroup, Textarea } from "@nais/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { useErrorText } from "@/shared/api/use-error-text";
import { notify } from "@/shared/ui/toast";
import { useCreateDatasetVersion } from "../api";
import { suggestNextLabels } from "./version-label";

const LABEL = /^[A-Za-z0-9._-]{1,32}$/;

/**
 * Create a DRAFT (spec §3.3b). Default: inherit the latest PUBLISHED version's files without re-upload (zero-copy).
 * `fromVersion` = revert: the draft starts from that older version's files. `latestLabel` null = no published version yet.
 */
export function NewDraftDialog({
  datasetId,
  latestLabel,
  fromVersion,
  open,
  onOpenChange,
}: {
  datasetId: string;
  latestLabel: string | null;
  fromVersion?: { id: string; label: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("data.versioning.dialog");
  const tc = useTranslations("common");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={tc("close")} className="sm:max-w-[30rem]">
        <DialogTitle>{fromVersion ? t("revertTitle") : t("title")}</DialogTitle>
        <DialogDescription>{fromVersion ? t("revertDescription", { label: fromVersion.label }) : t("description")}</DialogDescription>
        {/* Mounted per open, so every open starts from a clean form. */}
        <DraftForm datasetId={datasetId} latestLabel={latestLabel} fromVersion={fromVersion} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function DraftForm({ datasetId, latestLabel, fromVersion, onDone }: { datasetId: string; latestLabel: string | null; fromVersion?: { id: string; label: string }; onDone: () => void }) {
  const t = useTranslations("data.versioning.dialog");
  const tv = useTranslations();
  const router = useRouter();
  const errorText = useErrorText();
  const create = useCreateDatasetVersion(datasetId);
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [start, setStart] = useState<"inherit" | "empty">("inherit");
  const [error, setError] = useState<string | undefined>();
  const suggestionsId = useId();
  const startId = useId();
  const next = suggestNextLabels(latestLabel);
  const suggestions = next === null ? [] : latestLabel === null ? [{ label: next.minor, text: t("suggestFirst", { label: next.minor }) }] : [
    { label: next.minor, text: t("suggestMinor", { label: next.minor }) },
    { label: next.major, text: t("suggestMajor", { label: next.major }) },
  ];
  const showStart = !fromVersion && latestLabel !== null;

  return (
    <form
      className="mt-4 flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!LABEL.test(label)) {
          setError(tv("validation.versionLabel"));
          return;
        }
        setError(undefined);
        const body = {
          version_label: label,
          ...(note.trim() ? { change_note: note.trim() } : {}),
          ...(fromVersion ? { from_version_id: fromVersion.id } : showStart && start === "empty" ? { empty: true } : {}),
        };
        create.mutate(body, {
          onSuccess: (v) => {
            const inherited = v.files.filter((f) => f.inherited).length;
            notify.success(inherited > 0 ? t("inherited", { count: inherited }) : t("createdEmpty"));
            onDone();
            router.push(`/commons/data/${datasetId}/versions/${v.dataset_version_id}`);
          },
          onError: (err) => setError(errorText(err)),
        });
      }}
    >
      <div className="flex flex-col gap-2">
        <FormField id="draft-label" label={t("label")} required requiredLabel={tv("common.required")} hint={tv("data.version.labelHint")} error={error}>
          {(a11y) => <Input {...a11y} className="font-mono" autoComplete="off" spellCheck={false} value={label} onChange={(e) => setLabel(e.target.value)} />}
        </FormField>
        {suggestions.length ? (
          <div role="group" aria-labelledby={suggestionsId} className="flex flex-wrap items-center gap-1.5">
            <span id={suggestionsId} className="mr-1 text-caption text-fg-muted">
              {t("suggestions")}
            </span>
            {suggestions.map((s) => (
              <button
                key={s.text}
                type="button"
                aria-pressed={label === s.label}
                onClick={() => {
                  setLabel(s.label);
                  setError(undefined);
                }}
                className={cn(
                  "press inline-flex h-7 items-center rounded-sm border px-2.5 text-small transition-colors duration-[var(--dur-fast)]",
                  "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
                  label === s.label ? "border-accent bg-accent-soft text-accent-fg" : "border-border bg-bg-panel text-fg hover:bg-bg-hover",
                )}
              >
                {s.text}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {showStart ? (
        <div className="flex flex-col gap-2">
          <span id={startId} className="text-small font-medium text-fg">
            {t("start")}
          </span>
          <RadioGroup value={start} onValueChange={(v) => setStart(v === "empty" ? "empty" : "inherit")} aria-labelledby={startId}>
            <Radio value="inherit" label={t("inherit")} />
            <p className="-mt-1 pl-6 text-caption text-fg-muted">{t("inheritHint", { label: latestLabel })}</p>
            <Radio value="empty" label={t("empty")} />
            <p className="-mt-1 pl-6 text-caption text-fg-muted">{t("emptyHint")}</p>
          </RadioGroup>
        </div>
      ) : null}
      <FormField id="draft-note" label={t("note")} hint={t("noteHint")}>
        {(a11y) => <Textarea {...a11y} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />}
      </FormField>
      <DialogFooter>
        <Button variant="primary" type="submit" loading={create.isPending} disabled={create.isPending}>
          {t("create")}
        </Button>
      </DialogFooter>
    </form>
  );
}
