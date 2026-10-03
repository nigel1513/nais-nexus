"use client";
import { DataTable, EmptyState } from "@nais/ui";
import { FolderKanban } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useMemo } from "react";
import { useNote, useNotes } from "@/features/notes/api";
import { ProjectRoleBadge } from "@/features/projects/components/project-role-badge";
import { useListProjects } from "@/features/projects/api";
import { flattenPages } from "@/shared/api/pagination";
import type { ProjectSummary } from "@/shared/api/types";
import { useMeData } from "@/shared/hooks/use-me";
import { ScreenTitle } from "@/shared/ui/screen-v2";
import { DelayedSkeleton, ErrorView, LoadMore } from "@/shared/ui/state-views";
import { PanelHead } from "@/shared/ui/work-hero";
import { NotebookErrorAlert, OpenNotebookLink } from "./notebook-link";

/** Today in Asia/Seoul (the research-note day). */
const seoulToday = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);

/**
 * /commons/notebooks (M07-lite): my ACTIVE projects, each with "노트북 열기" into the shared JupyterLab, and — where today's
 * research note exists — how many notebooks I saved today (the note's draft_source_count; hidden otherwise).
 */
export function NotebooksScreen() {
  const t = useTranslations();
  const me = useMeData();
  const headingId = useId();
  const projects = useListProjects({ scope: "mine", status: "ACTIVE" });
  const today = seoulToday();
  const notes = useNotes({ role: "recorder", from: today, to: today });
  const noteByProject = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of flattenPages(notes.data)) if (n.note_date === today && n.status === "DRAFT") map.set(n.project_id, n.note_id);
    return map;
  }, [notes.data, today]);
  const rows = flattenPages(projects.data).filter((p) => p.my_role);

  return (
    <>
      <ScreenTitle context={[t("notebooks.context"), me.organization.name]} title={t("notebooks.title")} description={t("notebooks.description")} />
      <div className="flex flex-col gap-5">
        <NotebookErrorAlert />
        <section aria-labelledby={headingId} className="flex flex-col gap-3">
          <PanelHead id={headingId} crumb={t("notebooks.listCrumb")} title={t("notebooks.list")} count={projects.data ? rows.length : undefined} />
          <p className="max-w-3xl text-small text-fg-muted">{t("notebooks.hint")}</p>
          {projects.isPending ? (
            <DelayedSkeleton lines={4} />
          ) : projects.isError ? (
            <ErrorView error={projects.error} onRetry={() => void projects.refetch()} />
          ) : (
            <>
              <DataTable<ProjectSummary>
                caption={t("notebooks.list")}
                rows={rows}
                rowKey={(p) => p.project_id}
                empty={<EmptyState icon={FolderKanban} title={t("notebooks.empty")} description={t("notebooks.emptyHint")} />}
                columns={[
                  {
                    key: "project",
                    header: t("notebooks.col.project"),
                    className: "min-w-48",
                    cell: (p) => (
                      <Link href={`/commons/projects/${p.project_id}`} className="break-keep font-semibold text-fg underline-offset-4 hover:underline">
                        {p.name}
                      </Link>
                    ),
                  },
                  { key: "role", header: t("notebooks.col.role"), cell: (p) => (p.my_role ? <ProjectRoleBadge role={p.my_role} /> : "—") },
                  { key: "today", header: t("notebooks.col.today"), numeric: true, cell: (p) => <TodayCount noteId={noteByProject.get(p.project_id)} /> },
                  {
                    key: "open",
                    header: t("notebooks.col.open"),
                    cell: (p) => <OpenNotebookLink projectId={p.project_id} size="sm" aria-label={t("notebooks.openProject", { project: p.name })} />,
                  },
                ]}
              />
              <LoadMore hasNextPage={projects.hasNextPage} isFetchingNextPage={projects.isFetchingNextPage} fetchNextPage={projects.fetchNextPage} />
            </>
          )}
        </section>
      </div>
    </>
  );
}

/** Notebooks saved today in this project (today's note draft_source_count); "—" without a note of today. */
function TodayCount({ noteId }: { noteId: string | undefined }) {
  const t = useTranslations();
  if (noteId) return <NoteSourceCount noteId={noteId} />;
  // No note of today yet: the count is not fetched (opening a note would create it), only explained.
  return (
    <span className="text-fg-muted" title={t("notebooks.todayHint")}>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{t("notebooks.todayHint")}</span>
    </span>
  );
}

function NoteSourceCount({ noteId }: { noteId: string }) {
  const t = useTranslations();
  const note = useNote(noteId);
  if (!note.data) return <span className="text-fg-muted">—</span>;
  return <span className="num font-mono text-mono">{t("notebooks.todayCount", { count: note.data.draft_source_count })}</span>;
}
