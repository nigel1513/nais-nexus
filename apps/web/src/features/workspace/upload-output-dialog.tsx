"use client";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, FormField, Input, Progress, Radio, RadioGroup } from "@nais/ui";
import { TriangleAlert } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { ENUMS } from "@/generated/contracts";
import { hashFile } from "@/features/upload/lib/hash-client";
import { putWithProgress, withRetry } from "@/features/upload/lib/transfer";
import { asApiError } from "@/shared/api/errors";
import { useErrorText } from "@/shared/api/use-error-text";
import { formatBytes } from "@/shared/lib/format";
import { notify } from "@/shared/ui/toast";
import { completeOutputUpload, createOutputUpload, type AccessLevel } from "./api";
import { projectHref } from "./workspace-layout";

const LEVELS = ENUMS.AccessLevel as readonly AccessLevel[];
const NAME = /^[A-Za-z0-9._-]{1,255}$/;
const MAX_FILES = 20;
const MAX_BYTES = 5 * 1024 ** 3;

/** The strictest access level of the project's inputs: an output may not be looser. INTERNAL when there are none. */
export function accessFloor(levels: AccessLevel[]): AccessLevel {
  if (!levels.length) return "INTERNAL";
  return levels.reduce((a, b) => (LEVELS.indexOf(b) > LEVELS.indexOf(a) ? b : a), "PUBLIC" as AccessLevel);
}

type Phase = { kind: "idle" } | { kind: "hashing"; done: number } | { kind: "uploading"; sent: number; total: number } | { kind: "completing" };

/**
 * 파일 올리기: a report, a figure or any result file becomes a FILE output of the project. Each file is hashed
 * (sha256, pure JS — works on plain http), sent with one presigned PUT, then the upload is completed and re-checked by
 * the server. Its access level can't be looser than the strictest input of the project.
 */
export function UploadOutputDialog({ projectId, floor, open, onOpenChange }: { projectId: string; floor: AccessLevel; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t("common.close")} className="max-w-xl">
        <DialogTitle>{t("workspace.upload.title")}</DialogTitle>
        <DialogDescription>{t("workspace.upload.description")}</DialogDescription>
        {open ? <UploadForm projectId={projectId} floor={floor} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function UploadForm({ projectId, floor, onDone }: { projectId: string; floor: AccessLevel; onDone: () => void }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const router = useRouter();
  const qc = useQueryClient();
  const id = useId();
  const [title, setTitle] = useState("");
  const [level, setLevel] = useState<AccessLevel>(floor);
  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [levelError, setLevelError] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const floorIndex = LEVELS.indexOf(floor);
  const badNames = files.filter((f) => !NAME.test(f.name));
  const tooBig = files.filter((f) => f.size < 1 || f.size > MAX_BYTES);
  const busy = phase.kind !== "idle";
  const ready = title.trim() && files.length > 0 && files.length <= MAX_FILES && !badNames.length && !tooBig.length && !busy;

  const submit = async () => {
    if (!ready) return;
    setError(null);
    setLevelError(null);
    try {
      setPhase({ kind: "hashing", done: 0 });
      const declared = [];
      for (const [i, f] of files.entries()) {
        declared.push({ name: f.name, size_bytes: f.size, sha256: await hashFile(f), media_type: f.type || "application/octet-stream" });
        setPhase({ kind: "hashing", done: i + 1 });
      }
      const session = await createOutputUpload(projectId, { title: title.trim(), access_level: level, files: declared });
      const total = files.reduce((n, f) => n + f.size, 0);
      let sent = 0;
      setPhase({ kind: "uploading", sent, total });
      for (const f of files) {
        const target = session.files.find((x) => x.name === f.name);
        if (!target) continue;
        await withRetry(() => putWithProgress(target.upload.url, f, target.upload.headers ?? {}, (n) => setPhase({ kind: "uploading", sent: sent + n, total })));
        sent += f.size;
      }
      setPhase({ kind: "completing" });
      const output = await completeOutputUpload(projectId, session.output_id);
      void qc.invalidateQueries({ queryKey: ["listOutputs", { projectId }] });
      notify.success(t("workspace.upload.done", { title: output.title }));
      onDone();
      router.push(`${projectHref(projectId, "outputs")}/${output.output_id}`);
    } catch (e) {
      setPhase({ kind: "idle" });
      const err = asApiError(e);
      if (err.code === "VALIDATION_FAILED" && err.details.field === "access_level") {
        const minimum = typeof err.details.minimum === "string" && (LEVELS as readonly string[]).includes(err.details.minimum) ? (err.details.minimum as AccessLevel) : floor;
        setLevelError(t("workspace.upload.levelTooLoose", { level: t(`enums.AccessLevel.${minimum}`) }));
      } else setError(e);
    }
  };

  return (
    <form
      className="mt-4 flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <FormField id={`${id}-title`} label={t("workspace.upload.name")}>
        {(a11y) => <Input {...a11y} value={title} maxLength={300} disabled={busy} onChange={(e) => setTitle(e.target.value)} />}
      </FormField>
      <fieldset className="flex flex-col gap-2" aria-describedby={`${id}-level-hint${levelError ? ` ${id}-level-error` : ""}`}>
        <legend id={`${id}-level`} className="mb-1.5 text-small font-medium text-fg">
          {t("workspace.upload.level")}
        </legend>
        <RadioGroup aria-labelledby={`${id}-level`} value={level} onValueChange={(v) => setLevel(v as AccessLevel)} orientation="horizontal" disabled={busy}>
          {LEVELS.map((l, i) => (
            <Radio key={l} value={l} disabled={i < floorIndex} label={t(`enums.AccessLevel.${l}`)} />
          ))}
        </RadioGroup>
        <p id={`${id}-level-hint`} className="text-small text-fg-muted">
          {t("workspace.upload.floorHint", { level: t(`enums.AccessLevel.${floor}`) })}
        </p>
        {levelError ? (
          <p id={`${id}-level-error`} role="alert" className="text-small text-danger">
            {levelError}
          </p>
        ) : null}
      </fieldset>
      <FormField
        id={`${id}-files`}
        label={t("workspace.upload.files")}
        hint={t("workspace.upload.filesHint", { max: MAX_FILES })}
        error={badNames.length ? t("workspace.upload.badName", { names: badNames.map((f) => f.name).join(", ") }) : tooBig.length ? t("workspace.upload.badSize") : files.length > MAX_FILES ? t("workspace.upload.tooMany", { max: MAX_FILES }) : undefined}
      >
        {(a11y) => (
          <input
            {...a11y}
            type="file"
            multiple
            disabled={busy}
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            className="block w-full text-small text-fg file:mr-3 file:h-8 file:cursor-pointer file:rounded-md file:border file:border-border file:bg-bg-panel file:px-3 file:text-small file:font-medium file:text-fg hover:file:bg-bg-hover"
          />
        )}
      </FormField>
      {files.length ? (
        <ul className="flex flex-col gap-1 text-small">
          {files.map((f) => (
            <li key={f.name} className="flex justify-between gap-3">
              <span className="min-w-0 truncate font-mono text-mono">{f.name}</span>
              <span className="num shrink-0 text-fg-muted">{formatBytes(f.size)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {busy ? (
        <div role="status" className="flex flex-col gap-1.5 text-small text-fg-muted">
          {phase.kind === "hashing"
            ? t("workspace.upload.hashing", { done: phase.done, total: files.length })
            : phase.kind === "uploading"
              ? t("workspace.upload.uploading", { percent: phase.total ? Math.round((phase.sent / phase.total) * 100) : 0 })
              : t("workspace.upload.completing")}
          {phase.kind === "uploading" ? <Progress value={phase.total ? (phase.sent / phase.total) * 100 : 0} label={t("workspace.upload.progress")} /> : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="flex items-start gap-2 rounded-sm bg-warning-soft p-3 text-small text-fg">
          <TriangleAlert aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0 text-warning" />
          {errorText(error)}
        </p>
      ) : null}
      <DialogFooter className="mt-2">
        <Button variant="ghost" onClick={onDone} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={!ready}>
          {t("workspace.upload.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
