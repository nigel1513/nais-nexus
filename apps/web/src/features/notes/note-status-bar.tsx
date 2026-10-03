"use client";
import { Button } from "@nais/ui";
import { CircleAlert, CloudCheck, LoaderCircle, PencilLine, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { NoteStatusBadge } from "@/shared/ui/badges";
import type { ResearchNote } from "./api";
import type { NoteEditorState } from "./note-editor";

function SaveStatus({ editor }: { editor: NoteEditorState }) {
  const t = useTranslations();
  const time = new Date(editor.savedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Seoul" });
  const [icon, text]: [ReactNode, string] =
    editor.state === "conflict"
      ? [<CircleAlert key="i" className="text-warning" />, t("notes.save.conflictState")]
      : editor.state === "failed"
        ? [<CircleAlert key="i" className="text-danger" />, t("notes.save.failed")]
        : editor.state === "saving"
          ? [<LoaderCircle key="i" className="animate-spin" />, t("notes.save.saving")]
          : editor.state === "dirty"
            ? [<PencilLine key="i" />, t("notes.save.dirty")]
            : [<CloudCheck key="i" />, t("notes.save.savedAt", { time })];
  return (
    <span role="status" data-save-state={editor.state} className="inline-flex items-center gap-1.5 text-small text-fg-muted [&_svg]:size-3.5 [&_svg]:shrink-0">
      <span aria-hidden="true" className="contents">
        {icon}
      </span>
      <span className="sr-only">{t("notes.save.label")}: </span>
      {text}
    </span>
  );
}

export type DraftButtonState = { show: boolean; disabledReason: string | null; busy: boolean; onClick: () => void; reasonId: string };

/**
 * The bar above the form: status, version and (while editing) the save state on the left; on the right the actions
 * this viewer has on this note — AI draft, submit / sign, reject, new version, verify, export.
 */
export function NoteStatusBar({ note, editor, draft, actions }: { note: ResearchNote; editor: NoteEditorState | null; draft: DraftButtonState | null; actions: ReactNode }) {
  const t = useTranslations();
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-y border-border py-2.5">
      <div className="flex flex-wrap items-center gap-3" data-note-status="">
        <NoteStatusBadge status={note.status} />
        <span className="num font-mono text-mono text-fg-muted">{`v${note.version}`}</span>
        {editor ? <SaveStatus editor={editor} /> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {draft?.show ? (
          <Button onClick={draft.onClick} disabled={!!draft.disabledReason} loading={draft.busy} aria-describedby={draft.disabledReason ? draft.reasonId : undefined}>
            <Sparkles aria-hidden="true" strokeWidth={1.75} />
            {t("notes.ai.draft")}
          </Button>
        ) : null}
        {actions}
      </div>
      {draft?.show && draft.disabledReason ? (
        <p id={draft.reasonId} className="w-full text-small text-fg-muted md:order-last md:text-right">
          {draft.disabledReason}
        </p>
      ) : null}
    </div>
  );
}
