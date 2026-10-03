"use client";
import { DataTable, EmptyState, type DataColumn } from "@nais/ui";
import { BookText, Inbox } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { flattenPages } from "@/shared/api/pagination";
import { NoteStatusBadge } from "@/shared/ui/badges";
import { DateTime } from "@/shared/ui/date-text";
import { DelayedSkeleton, ErrorView, LoadMore } from "@/shared/ui/state-views";
import { useNotes, type NoteSummary, type NotesQuery } from "./api";

/**
 * A list of notes (latest version per day for 내 노트; submitted/signed notes for 확인할 노트), newest day first. The
 * date opens the note; the project column is left out inside a project, the recorder column shown for witnesses.
 */
export function NoteTable({ query, caption, showProject = true }: { query: NotesQuery; caption: string; showProject?: boolean }) {
  const t = useTranslations();
  const notes = useNotes(query);
  const witness = query.role === "witness";
  if (notes.isPending) return <DelayedSkeleton />;
  if (notes.isError) return <ErrorView error={notes.error} onRetry={() => void notes.refetch()} />;
  const rows = flattenPages(notes.data);
  const columns: DataColumn<NoteSummary>[] = [
    {
      key: "date",
      header: t("notes.list.date"),
      cell: (n) => (
        <Link href={`/commons/notes/${n.note_id}`} className="num font-mono text-mono font-medium text-fg underline-offset-4 hover:underline">
          {n.note_date}
          {n.version > 1 ? <span className="ml-1.5 text-fg-muted">{t("notes.list.version", { version: n.version })}</span> : null}
        </Link>
      ),
    },
    ...(showProject ? [{ key: "project", header: t("notes.list.project"), cell: (n: NoteSummary) => <span className="break-keep">{n.project_name}</span> }] : []),
    ...(witness ? [{ key: "recorder", header: t("notes.list.recorder"), cell: (n: NoteSummary) => n.recorder_display_name }] : []),
    { key: "status", header: t("notes.list.status"), cell: (n) => <NoteStatusBadge status={n.status} /> },
    ...(witness
      ? []
      : [
          {
            key: "review",
            header: t("notes.list.review"),
            cell: (n: NoteSummary) => (n.unaccepted_ai_count ? <span className="text-small text-accent-fg">{t("notes.list.unreviewed", { count: n.unaccepted_ai_count })}</span> : <span className="text-fg-muted">—</span>),
          },
        ]),
    { key: "updated", header: t("notes.list.updated"), numeric: true, cell: (n) => <DateTime value={n.updated_at} /> },
  ];
  return (
    <>
      <DataTable<NoteSummary>
        caption={caption}
        rows={rows}
        rowKey={(n) => n.note_id}
        columns={columns}
        empty={
          witness ? (
            <EmptyState icon={Inbox} title={t("notes.list.emptyWitness")} description={t("notes.list.emptyWitnessHint")} />
          ) : (
            <EmptyState icon={BookText} title={t("notes.list.emptyMine")} description={t("notes.list.emptyMineHint")} />
          )
        }
      />
      <LoadMore hasNextPage={notes.hasNextPage} isFetchingNextPage={notes.isFetchingNextPage} fetchNextPage={notes.fetchNextPage} />
    </>
  );
}
