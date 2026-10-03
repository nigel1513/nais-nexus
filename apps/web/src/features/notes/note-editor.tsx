"use client";
import { cn, focusRing, Textarea } from "@nais/ui";
import { FileCode2, Plus, Sparkles, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { asApiError } from "@/shared/api/errors";
import type { Schemas } from "@/shared/api/types";
import { DateTime } from "@/shared/ui/date-text";
import { draftPending, NOTE_SECTIONS, useSaveBlocks, type NoteBlockWrite, type NoteSection, type ResearchNote } from "./api";

/** A sentence on screen: `key` is stable while typing; `block_id` arrives with the first save of a new sentence. */
export type EditBlock = {
  key: string;
  block_id?: string;
  section: NoteSection;
  text: string;
  origin: Schemas["NoteBlockOrigin"];
  accepted: boolean;
  evidence: Schemas["NoteEvidence"][];
};

export const AUTOSAVE_MS = 1000;
const MAX_TEXT = 4000;
const sectionIndex = (s: NoteSection) => NOTE_SECTIONS.indexOf(s);
const fromNote = (n: ResearchNote): EditBlock[] => n.blocks.map((b) => ({ key: b.block_id, block_id: b.block_id, section: b.section, text: b.text, origin: b.origin, accepted: b.accepted, evidence: b.evidence }));
/** Template order, keeping the on-screen order inside a section. */
const serverView = (n: ResearchNote) => new Map(n.blocks.map((b) => [b.block_id, { section: b.section, text: b.text }]));
const ordered = (blocks: EditBlock[]) => [...blocks].sort((a, b) => sectionIndex(a.section) - sectionIndex(b.section));
let localSeq = 0;
const newKey = () => `new-${(localSeq += 1)}`;

export type SaveState = "saved" | "dirty" | "saving" | "failed" | "conflict";

export type NoteEditorState = ReturnType<typeof useNoteEditor>;

/**
 * Local copy of a DRAFT's sentences with auto-save: a change is sent AUTOSAVE_MS after the last keystroke, carrying
 * the revision the editor holds (If-Match). Saving replaces the block list (deleted sentences are dropped).
 * An AI sentence counts as reviewed (accepted) only when the recorder edits that sentence or presses 초안 확인 완료
 * (`acceptAll`); auto-save sends each AI sentence's own state, never a blanket acceptance.
 * A 409 caused only by AI sentences the server appended (a finished draft) is merged and retried once; any other
 * 409 stops auto-saving and keeps the unsaved text available to copy (`rescued`) across 다시 불러오기, as a failed save does.
 */
export function useNoteEditor(note: ResearchNote, editable: boolean, reload: () => Promise<ResearchNote | undefined>) {
  const t = useTranslations();
  const save = useSaveBlocks(note.note_id);
  const [blocks, setBlocks] = useState<EditBlock[]>(() => fromNote(note));
  const blocksRef = useRef(blocks);
  const revision = useRef(note.revision);
  /** The server's sentences as last seen (id → section and text), to tell a draft append from someone else's edit. */
  const server = useRef(serverView(note));
  const seq = useRef(0);
  const savedSeqRef = useRef(0);
  const [changeSeq, setChangeSeq] = useState(0);
  const [savedSeq, setSavedSeq] = useState(0);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [rescued, setRescued] = useState<{ text: string; from: "failed" | "conflict" } | null>(null);
  const [savedAt, setSavedAt] = useState<string>(note.updated_at);
  const inFlight = useRef<Promise<ResearchNote | null> | null>(null);
  const deleted = useRef(new Set<string>());
  const lastDraft = useRef(note.draft_status);
  const dirty = changeSeq !== savedSeq;

  const replace = (next: EditBlock[]) => {
    blocksRef.current = next;
    setBlocks(next);
  };
  const edit = (fn: (bs: EditBlock[]) => EditBlock[]) => {
    replace(fn(blocksRef.current));
    seq.current += 1;
    setChangeSeq(seq.current);
    setFailed(null);
  };

  /** The text on screen, by template section, for copying back after a conflict or a failed save. */
  const asText = useCallback(
    (bs: EditBlock[]) =>
      NOTE_SECTIONS.map((s) => {
        const lines = bs.filter((b) => b.section === s && b.text.trim()).map((b) => b.text);
        return lines.length ? `[${t(`enums.NoteSection.${s}`)}]\n${lines.join("\n")}` : null;
      })
        .filter(Boolean)
        .join("\n\n"),
    [t],
  );

  /** The AI sentences `fresh` has beyond what this editor last saw, when that is the only change (else null). */
  const appendedOnly = (fresh: ResearchNote): EditBlock[] | null => {
    const byId = new Map(fresh.blocks.map((b) => [b.block_id, b]));
    for (const [id, seen] of server.current) {
      const f = byId.get(id);
      if (!f || f.text !== seen.text || f.section !== seen.section) return null;
    }
    const extra = fromNote(fresh).filter((b) => !server.current.has(b.block_id!));
    return extra.length && extra.every((b) => b.origin === "AI") ? extra : null;
  };
  const mergeAppended = (fresh: ResearchNote, extra: EditBlock[]) => {
    revision.current = fresh.revision;
    server.current = serverView(fresh);
    const known = new Set(blocksRef.current.map((b) => b.block_id).filter(Boolean));
    replace([...blocksRef.current, ...extra.filter((b) => !known.has(b.block_id) && !deleted.current.has(b.block_id!))]);
  };

  const doSave = useCallback(
    (retried = false): Promise<ResearchNote | null> => {
      const at = seq.current;
      const snapshot = blocksRef.current;
      const sent = ordered(snapshot).filter((b) => b.text.trim());
      const omitted = new Set(snapshot.filter((b) => !b.text.trim()).map((b) => b.key));
      const body: NoteBlockWrite[] = sent.map((b) => ({ ...(b.block_id ? { block_id: b.block_id } : {}), section: b.section, text: b.text, ...(b.origin === "AI" ? { accepted: b.accepted } : {}) }));
      setSaving(true);
      const run: Promise<ResearchNote | null> = save
        .mutateAsync({ revision: revision.current, blocks: body })
        .then((n) => {
          revision.current = n.revision;
          server.current = serverView(n);
          const ids = new Map(sent.map((b, i) => [b.key, n.blocks[i]?.block_id]));
          // A sentence left empty was not sent, so the server deleted it: typed again, it is a new sentence of mine.
          replace(
            blocksRef.current.map((b) =>
              ids.has(b.key) ? { ...b, block_id: ids.get(b.key) ?? b.block_id } : omitted.has(b.key) && b.block_id ? { ...b, block_id: undefined, origin: "HUMAN", accepted: true, evidence: [] } : b,
            ),
          );
          savedSeqRef.current = at;
          setSavedSeq(at);
          setSavedAt(n.updated_at);
          setRescued((r) => (r?.from === "failed" ? null : r));
          return n;
        })
        .catch(async (e: unknown): Promise<ResearchNote | null> => {
          if (asApiError(e).code === "CONFLICT") {
            const fresh = retried ? undefined : await reload().catch(() => undefined);
            const extra = fresh ? appendedOnly(fresh) : null;
            if (fresh && extra) {
              mergeAppended(fresh, extra);
              inFlight.current = null;
              return doSave(true);
            }
            setConflict(true);
            setRescued({ text: asText(blocksRef.current), from: "conflict" });
          } else {
            setFailed(e);
            setRescued({ text: asText(blocksRef.current), from: "failed" });
          }
          return null;
        })
        .finally(() => {
          if (inFlight.current === run) {
            inFlight.current = null;
            setSaving(false);
          }
        });
      inFlight.current = run;
      return run;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs and stable helpers
    [save, asText, reload],
  );

  // Auto-save: AUTOSAVE_MS after the last change; paused while saving, after a failure (until the next change) and on a conflict.
  useEffect(() => {
    if (!editable || !dirty || saving || conflict || failed) return;
    const id = window.setTimeout(() => void doSave(), AUTOSAVE_MS);
    return () => window.clearTimeout(id);
  }, [editable, dirty, saving, conflict, failed, changeSeq, doSave]);

  // The server's copy moved on (a finished AI draft): take it, or merge its appended sentences into unsaved edits.
  useEffect(() => {
    const draftWasPending = lastDraft.current === "QUEUED" || lastDraft.current === "RUNNING";
    lastDraft.current = note.draft_status;
    if (note.revision <= revision.current) return;
    if (seq.current === savedSeqRef.current && !inFlight.current) {
      revision.current = note.revision;
      server.current = serverView(note);
      replace(fromNote(note));
      return;
    }
    const extra = draftWasPending && !draftPending(note) ? appendedOnly(note) : null;
    if (extra) mergeAppended(note, extra);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on each server copy
  }, [note]);

  /** Save now (pending changes first); resolves false when the note could not be saved. */
  const flush = useCallback(async (): Promise<boolean> => {
    if (inFlight.current) await inFlight.current;
    if (seq.current !== savedSeqRef.current) return (await doSave()) !== null;
    return true;
  }, [doSave]);

  const reloadLatest = useCallback(async () => {
    const fresh = await reload();
    if (!fresh) return;
    revision.current = fresh.revision;
    server.current = serverView(fresh);
    deleted.current.clear();
    replace(fromNote(fresh));
    savedSeqRef.current = seq.current;
    setSavedSeq(seq.current);
    setChangeSeq(seq.current);
    setConflict(false);
    setFailed(null);
    setSavedAt(fresh.updated_at);
  }, [reload]);

  const state: SaveState = conflict ? "conflict" : failed ? "failed" : saving ? "saving" : dirty ? "dirty" : "saved";
  return {
    blocks,
    state,
    savedAt,
    failed,
    conflict,
    rescued: rescued?.text ?? null,
    dismissRescued: () => setRescued(null),
    /** Unsaved or unsavable changes: the leave guard asks first. */
    pending: dirty || saving || conflict,
    unreviewed: blocks.filter((b) => b.origin === "AI" && !b.accepted).length,
    /** Editing an AI sentence is reviewing it: that sentence (only) becomes accepted. */
    setText: (key: string, text: string) => edit((bs) => bs.map((b) => (b.key === key ? { ...b, text, accepted: b.origin === "AI" ? true : b.accepted } : b))),
    add: (section: NoteSection) => edit((bs) => [...bs, { key: newKey(), section, text: "", origin: "HUMAN", accepted: true, evidence: [] }]),
    remove: (key: string) =>
      edit((bs) => {
        const gone = bs.find((b) => b.key === key);
        if (gone?.block_id) deleted.current.add(gone.block_id);
        return bs.filter((b) => b.key !== key);
      }),
    flush,
    /** 초안 확인 완료: every AI sentence still on screen is accepted as it stands, saved right away. */
    acceptAll: () => {
      edit((bs) => bs.map((b) => (b.origin === "AI" ? { ...b, accepted: true } : b)));
      return flush();
    },
    retry: () => {
      setFailed(null);
      void doSave();
    },
    reload: reloadLatest,
  };
}

// ---------------------------------------------------------------- the form

const headCell = "w-28 shrink-0 bg-bg-subtle px-3 py-2.5 text-left align-top text-small font-medium text-fg-muted md:w-40";

/**
 * The standard research-note form (연구노트 표준 양식): header block (과제명 · 연구일자 · 기록자 · 소속), the seven
 * template sections as labelled rows, and the signature block. Editable rows hold one textarea per sentence; AI
 * sentences carry a tint, the "AI 초안" label and their notebook evidence.
 */
export function NoteForm({ note, organizationName, editor, witnessLabel = null }: { note: ResearchNote; organizationName: string | undefined; editor: NoteEditorState | null; witnessLabel?: string | null }) {
  const t = useTranslations();
  const blocks: EditBlock[] = editor ? editor.blocks : fromNote(note);
  return (
    <div className="flex flex-col gap-6">
      <table aria-label={t("notes.head.label")} className="w-full table-fixed border-collapse overflow-hidden rounded-md border border-border text-body">
        <tbody>
          {(
            [
              ["project", note.project_name],
              ["date", <span key="d" className="num font-mono text-mono">{note.note_date}</span>],
              ["recorder", note.recorder_display_name],
              ["organization", organizationName ?? "—"],
            ] as const
          ).map(([k, v]) => (
            <tr key={k} className="border-b border-border last:border-b-0">
              <th scope="row" className={headCell}>
                {t(`notes.head.${k}`)}
              </th>
              <td className="break-keep px-3 py-2.5 text-fg [overflow-wrap:anywhere]">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="overflow-hidden rounded-md border border-border">
        {NOTE_SECTIONS.map((s) => (
          <SectionRow key={s} section={s} blocks={blocks.filter((b) => b.section === s)} editor={editor} />
        ))}
      </div>

      <Signatures note={note} witnessLabel={witnessLabel} />
    </div>
  );
}

function SectionRow({ section, blocks, editor }: { section: NoteSection; blocks: EditBlock[]; editor: NoteEditorState | null }) {
  const t = useTranslations();
  const labelId = useId();
  const name = t(`enums.NoteSection.${section}`);
  return (
    <div role="group" aria-labelledby={labelId} data-section={section} className="flex flex-col border-b border-border last:border-b-0 md:flex-row">
      <div id={labelId} className="shrink-0 border-b border-border bg-bg-subtle px-3 py-2.5 text-small font-medium text-fg-muted md:w-40 md:border-b-0 md:border-r">
        {name}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 px-3 py-2.5">
        {blocks.length ? (
          <ol className="flex flex-col gap-2">
            {blocks.map((b, i) => (
              <SentenceItem key={b.key} block={b} index={i + 1} sectionName={name} editor={editor} />
            ))}
          </ol>
        ) : editor ? null : (
          <p className="text-small text-fg-muted">{t("notes.form.empty")}</p>
        )}
        {editor ? (
          <button
            type="button"
            aria-label={t("notes.form.addLabel", { section: name })}
            onClick={() => editor.add(section)}
            className={cn("inline-flex h-7 w-fit items-center gap-1 rounded-sm px-1.5 text-small text-fg-muted hover:bg-bg-hover hover:text-fg", focusRing)}
          >
            <Plus aria-hidden="true" strokeWidth={1.75} className="size-3.5" />
            {t("notes.form.add")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function SentenceItem({ block, index, sectionName, editor }: { block: EditBlock; index: number; sectionName: string; editor: NoteEditorState | null }) {
  const t = useTranslations();
  const tagId = useId();
  const ai = block.origin === "AI";
  return (
    <li
      aria-labelledby={ai ? tagId : undefined}
      className={cn("flex min-w-0 flex-col gap-1.5", ai && "rounded-sm border-l-2 border-accent bg-accent-soft/60 py-1.5 pl-2.5 pr-1.5")}
    >
      {ai ? (
        <div className="flex flex-wrap items-center gap-1.5 text-caption">
          <span id={tagId} className="inline-flex items-center gap-1 font-medium text-accent-fg">
            <Sparkles aria-hidden="true" strokeWidth={1.75} className="size-3.5" />
            {t("notes.ai.label")}
            {block.accepted ? null : <span className="ml-1 rounded-xs bg-bg-panel px-1 text-fg-muted">{t("notes.ai.unreviewed")}</span>}
          </span>
          {block.evidence.length ? <span className="sr-only">{t("notes.ai.evidence")}</span> : null}
          {block.evidence.map((e, i) => (
            <span key={`${e.ref_id}-${i}`} title={t(`enums.NoteEvidenceType.${e.type}`)} className="inline-flex max-w-full items-center gap-1 rounded-sm border border-border bg-bg-panel px-1.5 py-px text-fg-muted">
              <FileCode2 aria-hidden="true" strokeWidth={1.75} className="size-3 shrink-0" />
              <span className="truncate">{e.label}</span>
            </span>
          ))}
        </div>
      ) : null}
      {editor ? (
        <div className="flex min-w-0 items-start gap-1.5">
          <Textarea
            aria-label={t("notes.form.sentence", { section: sectionName, n: index })}
            value={block.text}
            maxLength={MAX_TEXT}
            rows={Math.min(8, Math.max(2, Math.ceil(block.text.length / 70)))}
            placeholder={t("notes.form.placeholder")}
            onChange={(e) => editor.setText(block.key, e.target.value)}
            className="min-w-0 flex-1 [field-sizing:content]"
          />
          <button
            type="button"
            aria-label={t("notes.form.remove", { section: sectionName, n: index })}
            onClick={() => editor.remove(block.key)}
            className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-sm text-fg-muted hover:bg-bg-hover hover:text-danger", focusRing)}
          >
            <Trash2 aria-hidden="true" strokeWidth={1.75} className="size-4" />
          </button>
        </div>
      ) : (
        <p className="whitespace-pre-wrap break-keep text-body text-fg [overflow-wrap:anywhere]">{block.text}</p>
      )}
    </li>
  );
}

/** 서명란: recorder and (when the note needs one) witness — the signer, or the named witnesses — with the server's signing time or "서명 전". */
function Signatures({ note, witnessLabel }: { note: ResearchNote; witnessLabel: string | null }) {
  const t = useTranslations();
  const roles: Schemas["NoteSignerRole"][] = note.witness_required ? ["RECORDER", "WITNESS"] : ["RECORDER"];
  return (
    <table aria-label={t("notes.signatures.label")} className="w-full table-fixed border-collapse overflow-hidden rounded-md border border-border text-body">
      <thead className="sr-only">
        <tr>
          <th scope="col">{t("notes.signatures.role")}</th>
          <th scope="col">{t("notes.signatures.signer")}</th>
          <th scope="col">{t("notes.signatures.signedAt")}</th>
        </tr>
      </thead>
      <tbody>
        {roles.map((role) => {
          const s = note.signatures.find((x) => x.role === role);
          return (
            <tr key={role} className="border-b border-border last:border-b-0">
              <th scope="row" className={headCell}>
                {t(`enums.NoteSignerRole.${role}`)}
              </th>
              <td className="px-3 py-2.5 text-fg">{s ? s.signer_display_name : role === "RECORDER" ? note.recorder_display_name : (witnessLabel ?? "—")}</td>
              <td className="px-3 py-2.5 text-right text-small text-fg-muted">{s ? <DateTime value={s.signed_at} /> : t("notes.signatures.notSigned")}</td>
            </tr>
          );
        })}
        {note.content_hash ? (
          <tr>
            <th scope="row" className={headCell}>
              {t("notes.signatures.contentHash")}
            </th>
            <td colSpan={2} className="px-3 py-2.5 font-mono text-mono text-fg-muted [overflow-wrap:anywhere]">
              {note.content_hash}
            </td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}
