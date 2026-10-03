"use client";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, FormField, Textarea } from "@nais/ui";
import { ShieldCheck, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { reauthenticate } from "@/features/auth/reauth";
import { asApiError } from "@/shared/api/errors";
import type { Schemas } from "@/shared/api/types";
import { useErrorText } from "@/shared/api/use-error-text";
import { isMocking } from "@/shared/config";
import { notify } from "@/shared/ui/toast";
import { useRejectNote, useSignNote, type ResearchNote } from "./api";

/** Where the browser comes back after re-authenticating for a signature: the note, reopening this dialog. */
export const signReturnUrl = (noteId: string) => `/commons/notes/${noteId}?sign=1`;

/**
 * 서명: what is being signed (과제 · 연구일자 · 서명자 · 역할), then signNote. The server wants a login younger than
 * 5 minutes; a 401 NOTE_SIGNATURE_EXPIRED (kept away from the global sign-in handler) turns the button into a fresh
 * login — Keycloak with max_age=0, returning to this note with ?sign=1 — or, with the mock API, a renewed mock login
 * for the same user, after which the signature is retried in place.
 */
export function SignDialog({
  note,
  role,
  signerName,
  onClose,
  beforeSign,
}: {
  note: ResearchNote;
  role: Schemas["NoteSignerRole"];
  signerName: string;
  onClose: () => void;
  /** Saves pending edits first (a DRAFT signed directly); false stops the signature. */
  beforeSign?: () => Promise<boolean>;
}) {
  const t = useTranslations();
  const errorText = useErrorText();
  const sign = useSignNote(note.note_id);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const attempt = async () => {
    setError(null);
    setBusy(true);
    try {
      if (beforeSign && !(await beforeSign())) return;
      const signed = await sign.mutateAsync();
      notify.success(signed.status === "SIGNED" ? t("notes.sign.completed") : t("notes.sign.signed"));
      onClose();
    } catch (e) {
      if (asApiError(e).code === "NOTE_SIGNATURE_EXPIRED") setExpired(true);
      else setError(e);
    } finally {
      setBusy(false);
    }
  };

  const confirmAgain = async () => {
    setBusy(true);
    const how = await reauthenticate(signReturnUrl(note.note_id));
    setBusy(false);
    if (how === "refreshed") {
      setExpired(false);
      await attempt();
    }
  };

  const facts: [string, string][] = [
    [t("notes.head.project"), note.project_name],
    [t("notes.head.date"), note.note_date],
    [t("notes.sign.signer"), signerName],
    [t("notes.sign.role"), t(`enums.NoteSignerRole.${role}`)],
  ];
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent closeLabel={t("common.close")}>
        <DialogTitle>{t("notes.sign.title")}</DialogTitle>
        <DialogDescription>
          {t("notes.sign.description")}
          {note.status === "DRAFT" ? ` ${t("notes.sign.draftDescription")}` : null}
        </DialogDescription>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-md border border-border bg-bg-subtle p-3 text-small">
          {facts.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-fg-muted">{k}</dt>
              <dd className="min-w-0 break-keep text-fg [overflow-wrap:anywhere]">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-caption text-fg-muted">{t("notes.sign.time")}</p>
        {expired ? (
          <p role="alert" className="mt-3 flex items-start gap-2 rounded-md border border-warning-line bg-warning-soft p-3 text-small text-fg">
            <ShieldCheck aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0 text-warning" />
            {t("notes.sign.expired")}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-3 flex items-start gap-2 rounded-md border border-danger-line bg-danger-soft p-3 text-small text-fg">
            <TriangleAlert aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0 text-danger" />
            {errorText(error)}
          </p>
        ) : null}
        <DialogFooter className="mt-4">
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          {expired ? (
            <Button variant="primary" loading={busy} onClick={() => void confirmAgain()}>
              {isMocking() ? t("notes.sign.reauthInPlace") : t("notes.sign.reauth")}
            </Button>
          ) : (
            <Button variant="primary" loading={busy} onClick={() => void attempt()}>
              {t("notes.sign.confirm")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 반려 (witness): a required reason; the note goes back to the recorder as a DRAFT. */
export function RejectDialog({ note, onClose }: { note: ResearchNote; onClose: () => void }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const id = useId();
  const reject = useRejectNote(note.note_id);
  const [reason, setReason] = useState("");
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent closeLabel={t("common.close")}>
        <DialogTitle>{t("notes.reject.title")}</DialogTitle>
        <DialogDescription>{t("notes.reject.description")}</DialogDescription>
        <form
          className="mt-4 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!reason.trim()) return;
            reject.mutate(reason.trim(), {
              onSuccess: () => {
                notify.success(t("notes.reject.done"));
                onClose();
              },
            });
          }}
        >
          <FormField id={`${id}-reason`} label={t("notes.reject.reason")} required error={reject.isError ? errorText(reject.error) : undefined}>
            {(a11y) => <Textarea {...a11y} rows={4} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </FormField>
          <DialogFooter>
            <Button variant="secondary" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="danger" loading={reject.isPending} disabled={!reason.trim()}>
              {t("notes.reject.confirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
