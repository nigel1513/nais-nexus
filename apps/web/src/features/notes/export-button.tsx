"use client";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, FormField, Input } from "@nais/ui";
import { Download } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { useErrorText } from "@/shared/api/use-error-text";
import { notify } from "@/shared/ui/toast";
import { fetchNotesExport } from "./api";

/** Hands a downloaded blob to the browser's save (object URL; works on plain http, no secure-context API). */
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function useExport() {
  const t = useTranslations();
  const errorText = useErrorText();
  const [busy, setBusy] = useState(false);
  const run = async (query: { project_id: string; from?: string; to?: string }) => {
    setBusy(true);
    try {
      const { blob, filename } = await fetchNotesExport(query);
      saveBlob(blob, filename);
      notify.success(t("notes.actions.exported"));
      return true;
    } catch (e) {
      notify.error(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

/** 내보내기 for one day of a project (the note's day): ZIP of JSON, readable HTML and hashes.csv. */
export function ExportButton({ projectId, date }: { projectId: string; date: string }) {
  const t = useTranslations();
  const { busy, run } = useExport();
  return (
    <Button loading={busy} onClick={() => void run({ project_id: projectId, from: date, to: date })}>
      <Download aria-hidden="true" strokeWidth={1.75} />
      {t("notes.actions.export")}
    </Button>
  );
}

/** 내보내기 for a project with an optional date range (both ends inclusive, Asia/Seoul dates). */
export function ExportRangeButton({ projectId }: { projectId: string }) {
  const t = useTranslations();
  const id = useId();
  const { busy, run } = useExport();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const invalid = !!from && !!to && from > to;
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Download aria-hidden="true" strokeWidth={1.75} />
        {t("notes.actions.export")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent closeLabel={t("common.close")}>
          <DialogTitle>{t("notes.export.title")}</DialogTitle>
          <DialogDescription>{t("notes.export.description")}</DialogDescription>
          <form
            className="mt-4 flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (invalid) return;
              void run({ project_id: projectId, from: from || undefined, to: to || undefined }).then((ok) => ok && setOpen(false));
            }}
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField id={`${id}-from`} label={t("notes.export.from")}>
                {(a11y) => <Input {...a11y} type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />}
              </FormField>
              <FormField id={`${id}-to`} label={t("notes.export.to")}>
                {(a11y) => <Input {...a11y} type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />}
              </FormField>
            </div>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" variant="primary" loading={busy} disabled={invalid}>
                {t("notes.export.download")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
