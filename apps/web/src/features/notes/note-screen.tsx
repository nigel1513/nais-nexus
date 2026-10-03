"use client";
import { Button, ConfirmDialog, Textarea } from "@nais/ui";
import { ArrowLeft, CopyPlus, LoaderCircle, MessageSquareWarning, RotateCw, ShieldCheck, Signature, Sparkles, TriangleAlert, Undo2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useOrgNames } from "@/features/organizations/api";
import { asApiError } from "@/shared/api/errors";
import { useErrorText } from "@/shared/api/use-error-text";
import { useBeforeUnload, useNavigationGuard } from "@/shared/hooks/use-leave-guard";
import { useMeData } from "@/shared/hooks/use-me";
import { useBreadcrumbs } from "@/shared/ui/breadcrumbs";
import { ScreenTitle } from "@/shared/ui/screen-v2";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { notify } from "@/shared/ui/toast";
import { draftPending, useDraftNote, useNote, useNoteSettings, useReviseNote, useSubmitNote, type ResearchNote } from "./api";
import { ExportButton } from "./export-button";
import { NoteForm, useNoteEditor, type NoteEditorState } from "./note-editor";
import { NoteStatusBar } from "./note-status-bar";
import { RejectDialog, SignDialog } from "./sign-dialog";
import { VerifyPanel } from "./verify-panel";

export const noteHref = (noteId: string) => `/commons/notes/${noteId}`;

/** /commons/notes/{id}: one research note (also the target of 제출 · 반려 · 서명 notifications). */
export function NoteScreen({ noteId }: { noteId: string }) {
  const q = useNote(noteId);
  const { refetch } = q;
  const reload = useCallback(async () => (await refetch()).data, [refetch]);
  if (q.isPending) return <DelayedSkeleton lines={8} />;
  if (q.isError) return <ErrorView error={q.error} onRetry={() => void q.refetch()} />;
  return <NoteView key={noteId} note={q.data} reload={reload} />;
}

type Dialog = "submit" | "sign" | "reject" | null;

function NoteView({ note, reload }: { note: ResearchNote; reload: () => Promise<ResearchNote | undefined> }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const me = useMeData();
  const orgNames = useOrgNames();
  const router = useRouter();
  const params = useSearchParams();
  const ids = { reason: useId(), ai: useId() };
  const title = t("notes.noteTitle", { date: note.note_date });
  useBreadcrumbs([{ label: t("notes.title"), href: "/commons/notes" }, { label: title }]);

  const isRecorder = me.user_id === note.recorder_id;
  const editable = isRecorder && note.status === "DRAFT";
  const editor = useNoteEditor(note, editable, reload);
  const live: NoteEditorState | null = editable ? editor : null;

  const guard = useNavigationGuard(t("notes.save.leave"));
  const { setDirty } = guard;
  const leaving = editable && editor.pending;
  useBeforeUnload(leaving);
  useEffect(() => setDirty(leaving), [setDirty, leaving]);

  const settings = useNoteSettings(note.project_id);
  const draft = useDraftNote(note.note_id);
  const submit = useSubmitNote(note.note_id);
  const revise = useReviseNote(note.note_id);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [verifying, setVerifying] = useState(false);
  const [draftError, setDraftError] = useState<unknown>(null);
  const [submitError, setSubmitError] = useState<unknown>(null);

  const signed = (role: "RECORDER" | "WITNESS") => note.signatures.some((s) => s.role === role);
  const isWitness = !isRecorder && note.status === "SUBMITTED" && note.witness_required && note.witness_user_ids.includes(me.user_id);
  const recorderCanSign = isRecorder && (note.status === "SUBMITTED" ? !signed("RECORDER") : note.status === "DRAFT" && !note.witness_required);
  const witnessCanSign = isWitness && !signed("WITNESS");
  const blockedByAi = editable && editor.unreviewed > 0;

  // Back from a fresh login for signing (?sign=1): reopen the sign dialog once, and drop the flag from the URL.
  const reopened = useRef(false);
  useEffect(() => {
    if (reopened.current || params.get("sign") !== "1") return;
    reopened.current = true;
    if (recorderCanSign || witnessCanSign) setDialog("sign");
    router.replace(noteHref(note.note_id), { scroll: false });
  }, [params, recorderCanSign, witnessCanSign, router, note.note_id]);

  const draftText = (e: unknown) => {
    const err = asApiError(e);
    if (err.code === "VALIDATION_FAILED" && err.details.reason === "NO_NOTEBOOK_ACTIVITY") return t("notes.ai.noSource");
    if (err.code === "RATE_LIMITED") return t("notes.ai.rateLimited");
    if (err.code === "DEPENDENCY_UNAVAILABLE") return t("notes.ai.sourceUnavailable");
    return errorText(e);
  };
  const startDraft = async () => {
    setDraftError(null);
    if (!(await editor.flush())) return;
    draft.mutate(undefined, { onError: setDraftError });
  };

  const actions = (
    <>
      {editable ? (
        note.witness_required ? (
          <Button variant="primary" disabled={blockedByAi} aria-describedby={blockedByAi ? ids.ai : undefined} onClick={() => setDialog("submit")}>
            {t("notes.actions.submit")}
          </Button>
        ) : (
          <Button variant="primary" disabled={blockedByAi} aria-describedby={blockedByAi ? ids.ai : undefined} onClick={() => setDialog("sign")}>
            <Signature aria-hidden="true" strokeWidth={1.75} />
            {t("notes.actions.signDraft")}
          </Button>
        )
      ) : null}
      {isRecorder && note.status === "SUBMITTED" && recorderCanSign ? (
        <Button variant="primary" onClick={() => setDialog("sign")}>
          <Signature aria-hidden="true" strokeWidth={1.75} />
          {t("notes.actions.sign")}
        </Button>
      ) : null}
      {isWitness ? (
        <>
          <Button onClick={() => setDialog("reject")}>
            <Undo2 aria-hidden="true" strokeWidth={1.75} />
            {t("notes.actions.reject")}
          </Button>
          {witnessCanSign ? (
            <Button variant="primary" onClick={() => setDialog("sign")}>
              <Signature aria-hidden="true" strokeWidth={1.75} />
              {t("notes.actions.sign")}
            </Button>
          ) : null}
        </>
      ) : null}
      {isRecorder && note.status === "SIGNED" ? (
        <Button
          loading={revise.isPending}
          onClick={() =>
            revise.mutate(undefined, {
              onSuccess: (n) => {
                notify.success(t("notes.actions.revised", { version: n.version }));
                router.push(noteHref(n.note_id));
              },
              onError: (e) => notify.error(errorText(e)),
            })
          }
        >
          <CopyPlus aria-hidden="true" strokeWidth={1.75} />
          {t("notes.actions.revise")}
        </Button>
      ) : null}
      {note.status !== "DRAFT" ? (
        <Button onClick={() => setVerifying(true)} aria-expanded={verifying}>
          <ShieldCheck aria-hidden="true" strokeWidth={1.75} />
          {t("notes.actions.verify")}
        </Button>
      ) : null}
      {isRecorder ? <ExportButton projectId={note.project_id} date={note.note_date} /> : null}
    </>
  );

  return (
    <>
      <Link href="/commons/notes" className="mb-3 inline-flex items-center gap-1 rounded-sm text-small text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
        <ArrowLeft aria-hidden="true" strokeWidth={1.75} className="size-3.5" />
        {t("notes.back")}
      </Link>
      <ScreenTitle context={[t("notes.title"), note.project_name]} title={title} />
      <div className="flex flex-col gap-5">
        <NoteStatusBar
          note={note}
          editor={live}
          draft={
            editable && settings.data?.llm_enabled
              ? {
                  show: true,
                  disabledReason: note.draft_source_count === 0 ? t("notes.ai.noSource") : null,
                  busy: draft.isPending || draftPending(note),
                  onClick: () => void startDraft(),
                  reasonId: ids.reason,
                }
              : null
          }
          actions={actions}
        />

        {editable && note.rejected_reason ? (
          <div className="flex items-start gap-2 rounded-md border border-warning-line bg-warning-soft p-3 text-small text-fg">
            <MessageSquareWarning aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="font-medium">{t("notes.rejected.title")}</p>
              <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{note.rejected_reason}</p>
              <p className="text-fg-muted">{t("notes.rejected.hint")}</p>
            </div>
          </div>
        ) : null}

        {editable && draftPending(note) ? (
          <p role="status" className="flex items-center gap-2 text-small text-fg-muted">
            <LoaderCircle aria-hidden="true" strokeWidth={1.75} className="size-4 animate-spin" />
            {note.draft_status === "QUEUED" ? t("notes.ai.queued", { count: note.draft_source_count }) : t("notes.ai.running")}
          </p>
        ) : null}
        {editable && note.draft_status === "FAILED" ? (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-danger-line bg-danger-soft p-3 text-small text-fg">
            <TriangleAlert aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0 text-danger" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="font-medium">{t("notes.ai.failed")}</p>
              {note.draft_error ? <p>{note.draft_error}</p> : null}
            </div>
          </div>
        ) : null}
        {draftError ? (
          <p role="alert" className="flex items-start gap-2 rounded-md border border-warning-line bg-warning-soft p-3 text-small text-fg">
            <TriangleAlert aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0 text-warning" />
            {draftText(draftError)}
          </p>
        ) : null}

        {blockedByAi ? (
          <div className="flex flex-col items-start gap-2 rounded-md border border-accent/40 bg-accent-soft p-3 text-small text-fg sm:flex-row sm:items-center sm:justify-between">
            <p id={ids.ai} className="flex items-start gap-2">
              <Sparkles aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0 text-accent-fg" />
              {t("notes.ai.pending", { count: editor.unreviewed })}
            </p>
            <Button size="sm" loading={editor.state === "saving"} onClick={() => void editor.saveNow()}>
              {t("notes.ai.accept")}
            </Button>
          </div>
        ) : null}

        {editable ? <SaveProblems editor={editor} /> : null}
        {verifying ? <VerifyPanel noteId={note.note_id} /> : null}

        <NoteForm note={note} editor={live} organizationName={orgNames[note.organization_id] ?? (me.organization.organization_id === note.organization_id ? me.organization.name : undefined)} />
      </div>

      {dialog === "sign" ? (
        <SignDialog
          note={note}
          role={isRecorder ? "RECORDER" : "WITNESS"}
          signerName={me.display_name}
          beforeSign={editable ? editor.flush : undefined}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "reject" ? <RejectDialog note={note} onClose={() => setDialog(null)} /> : null}
      <ConfirmDialog
        open={dialog === "submit"}
        onOpenChange={(o) => {
          if (!o) {
            setDialog(null);
            setSubmitError(null);
          }
        }}
        title={t("notes.actions.submitTitle")}
        description={t("notes.actions.submitDescription")}
        confirmLabel={t("notes.actions.submit")}
        cancelLabel={t("common.cancel")}
        closeLabel={t("common.close")}
        pending={submit.isPending}
        onConfirm={async () => {
          setSubmitError(null);
          if (!(await editor.flush())) return setDialog(null);
          submit.mutate(undefined, {
            onSuccess: () => {
              setDialog(null);
              notify.success(t("notes.actions.submitted"));
            },
            onError: setSubmitError,
          });
        }}
      >
        {submitError ? (
          <p role="alert" className="flex items-start gap-2 text-small text-fg">
            <TriangleAlert aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0 text-danger" />
            {errorText(submitError)}
          </p>
        ) : null}
      </ConfirmDialog>
      {guard.dialog}
    </>
  );
}

/** Save failures and conflicts: the message, the way out (다시 저장 / 다시 불러오기) and the unsaved text to copy. */
function SaveProblems({ editor }: { editor: NoteEditorState }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const id = useId();
  if (editor.failed && !editor.conflict) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 rounded-md border border-danger-line bg-danger-soft p-3 text-small text-fg">
        <p className="flex items-start gap-2">
          <TriangleAlert aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0 text-danger" />
          {errorText(editor.failed)}
        </p>
        <Button size="sm" onClick={editor.retry}>
          <RotateCw aria-hidden="true" strokeWidth={1.75} />
          {t("notes.save.retry")}
        </Button>
      </div>
    );
  }
  if (!editor.conflict && editor.rescued === null) return null;
  const rescued = editor.rescued ? (
    <div className="flex w-full flex-col gap-1.5">
      <label htmlFor={`${id}-rescued`} className="text-small font-medium text-fg">
        {t("notes.save.rescued")}
      </label>
      <Textarea id={`${id}-rescued`} readOnly rows={6} value={editor.rescued} className="w-full font-mono text-mono" onFocus={(e) => e.currentTarget.select()} />
    </div>
  ) : null;
  if (editor.conflict) {
    return (
      <div role="alert" className="flex flex-col items-start gap-3 rounded-md border border-warning-line bg-warning-soft p-3 text-small text-fg">
        <p className="flex items-start gap-2">
          <TriangleAlert aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0 text-warning" />
          {t("notes.save.conflict")}
        </p>
        {rescued}
        <Button size="sm" onClick={() => void editor.reload()}>
          <RotateCw aria-hidden="true" strokeWidth={1.75} />
          {t("notes.save.reload")}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-3 rounded-md border border-border bg-bg-subtle p-3 text-small text-fg">
      <p className="text-fg-muted">{t("notes.save.rescuedHint")}</p>
      {rescued}
      <Button size="sm" variant="ghost" onClick={editor.dismissRescued}>
        {t("notes.save.dismiss")}
      </Button>
    </div>
  );
}
