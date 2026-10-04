"use client";
import { Button, ConfirmDialog, Textarea } from "@nais/ui";
import { ArrowLeft, CopyPlus, LoaderCircle, MessageSquareWarning, RotateCw, ShieldCheck, Signature, Sparkles, TriangleAlert, Undo2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useOrgNames } from "@/features/organizations/api";
import { useListProjectMembers } from "@/features/projects/api";
import { asApiError } from "@/shared/api/errors";
import { useErrorText } from "@/shared/api/use-error-text";
import { useBeforeUnload, useNavigationGuard } from "@/shared/hooks/use-leave-guard";
import { useMeData } from "@/shared/hooks/use-me";
import { useBreadcrumbs } from "@/shared/ui/breadcrumbs";
import { ScreenTitle } from "@/shared/ui/screen-v2";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { notify } from "@/shared/ui/toast";
import { OpenNotebookLink } from "@/features/notebooks/notebook-link";
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

/** A draft that FAILED for want of a saved notebook (draft_error is free text; the API and mock both say this). */
const NO_NOTEBOOK_TEXT = /저장한 노트북이 없습니다/;

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
  const members = useListProjectMembers(note.project_id);
  // 확인자: the note's snapshot once submitted; while DRAFT, the project's configured witnesses (never the recorder).
  const witnessIds = (note.status === "DRAFT" ? (settings.data?.witness_user_ids ?? note.witness_user_ids) : note.witness_user_ids).filter((w) => w !== note.recorder_id);
  const witnessNames = witnessIds.map((w) => members.data?.items.find((m) => m.user_id === w)?.display_name).filter((n): n is string => !!n);
  const witnessLabel = witnessNames.length > 1 ? t("notes.signatures.witnesses", { name: witnessNames[0]!, count: witnessNames.length - 1 }) : (witnessNames[0] ?? null);
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
  const aiNotice = useRef<HTMLDivElement>(null);

  // Back from a fresh login for signing (?sign=1): reopen the sign dialog once, and drop the flag from the URL.
  const reopened = useRef(false);
  useEffect(() => {
    if (reopened.current || params.get("sign") !== "1") return;
    reopened.current = true;
    if (recorderCanSign || witnessCanSign) setDialog("sign");
    router.replace(noteHref(note.note_id), { scroll: false });
  }, [params, recorderCanSign, witnessCanSign, router, note.note_id]);

  const noSource = t("notes.ai.noSource", { date: note.note_date });
  const noNotebook = (e: unknown) => {
    const err = asApiError(e);
    return err.code === "VALIDATION_FAILED" && err.details.reason === "NO_NOTEBOOK_ACTIVITY";
  };
  /** The way out of "no notebook saved": the project's 노트북 tab. */
  const notebookTab = (
    <OpenNotebookLink projectId={note.project_id} size="sm">
      {t("notes.ai.openNotebookTab")}
    </OpenNotebookLink>
  );
  const draftText = (e: unknown) => {
    const err = asApiError(e);
    if (noNotebook(e)) return noSource;
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
      {/* With drafting on, the link sits next to "AI 초안 만들기" (NoteStatusBar); without it, it leads the actions. */}
      {editable && !settings.data?.llm_enabled ? <OpenNotebookLink projectId={note.project_id}>{t("notes.ai.openNotebook")}</OpenNotebookLink> : null}
      {editable ? (
        note.witness_required ? (
          <Button variant="primary" className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50" aria-disabled={blockedByAi || undefined} aria-describedby={blockedByAi ? ids.ai : undefined} onClick={() => (blockedByAi ? aiNotice.current?.focus() : setDialog("submit"))}>
            {t("notes.actions.submit")}
          </Button>
        ) : (
          <Button variant="primary" className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50" aria-disabled={blockedByAi || undefined} aria-describedby={blockedByAi ? ids.ai : undefined} onClick={() => (blockedByAi ? aiNotice.current?.focus() : setDialog("sign"))}>
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
                  disabledReason: note.draft_source_count === 0 ? noSource : null,
                  notebook: <OpenNotebookLink projectId={note.project_id}>{t("notes.ai.openNotebook")}</OpenNotebookLink>,
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

        {editable ? (
          <p role="status" className={draftPending(note) ? "flex items-center gap-2 text-small text-fg-muted" : "sr-only"}>
            {draftPending(note) ? (
              <>
                <LoaderCircle aria-hidden="true" strokeWidth={1.75} className="size-4 animate-spin" />
                {note.draft_status === "QUEUED" ? t("notes.ai.queued", { count: note.draft_source_count }) : t("notes.ai.running")}
              </>
            ) : null}
          </p>
        ) : null}
        {editable && note.draft_status === "FAILED" ? (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-danger-line bg-danger-soft p-3 text-small text-fg">
            <TriangleAlert aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0 text-danger" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="font-medium">{t("notes.ai.failed")}</p>
              {note.draft_error ? <p>{note.draft_error}</p> : null}
              {note.draft_error && NO_NOTEBOOK_TEXT.test(note.draft_error) ? <div className="mt-1.5">{notebookTab}</div> : null}
            </div>
          </div>
        ) : null}
        {draftError ? (
          <div role="alert" className="flex flex-col items-start gap-2 rounded-md border border-warning-line bg-warning-soft p-3 text-small text-fg sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-start gap-2">
              <TriangleAlert aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0 text-warning" />
              {draftText(draftError)}
            </p>
            {noNotebook(draftError) ? notebookTab : null}
          </div>
        ) : null}

        {blockedByAi ? (
          <div ref={aiNotice} tabIndex={-1} className="flex flex-col items-start gap-2 rounded-md border border-accent/40 bg-accent-soft p-3 text-small text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus sm:flex-row sm:items-center sm:justify-between">
            <p id={ids.ai} className="flex items-start gap-2">
              <Sparkles aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0 text-accent-fg" />
              {t("notes.ai.pending", { count: editor.unreviewed })}
            </p>
            <Button size="sm" loading={editor.state === "saving"} onClick={() => void editor.acceptAll()}>
              {t("notes.ai.accept")}
            </Button>
          </div>
        ) : null}

        {editable ? <SaveProblems editor={editor} /> : null}
        {verifying ? <VerifyPanel noteId={note.note_id} status={note.status} /> : null}

        <NoteForm note={note} editor={live} witnessLabel={witnessLabel} organizationName={orgNames[note.organization_id] ?? (me.organization.organization_id === note.organization_id ? me.organization.name : undefined)} />
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
  if (!editor.conflict && !editor.failed && editor.rescued === null) return null;
  const rescued = editor.rescued ? (
    <div className="flex w-full flex-col gap-1.5">
      <label htmlFor={`${id}-rescued`} className="text-small font-medium text-fg">
        {t("notes.save.rescued")}
      </label>
      <Textarea id={`${id}-rescued`} readOnly rows={6} value={editor.rescued} className="w-full font-mono text-mono" onFocus={(e) => e.currentTarget.select()} />
    </div>
  ) : null;
  if (editor.failed && !editor.conflict) {
    return (
      <div role="alert" className="flex flex-col items-start gap-3 rounded-md border border-danger-line bg-danger-soft p-3 text-small text-fg">
        <p className="flex items-start gap-2">
          <TriangleAlert aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0 text-danger" />
          {errorText(editor.failed)}
        </p>
        {rescued}
        <Button size="sm" onClick={editor.retry}>
          <RotateCw aria-hidden="true" strokeWidth={1.75} />
          {t("notes.save.retry")}
        </Button>
      </div>
    );
  }
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
