"use client";
import { DataTable, EmptyState } from "@nais/ui";
import { Play } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { flattenPages } from "@/shared/api/pagination";
import { WorkspaceRunBadge } from "@/shared/ui/badges";
import { DateTime } from "@/shared/ui/date-text";
import { DelayedSkeleton, ErrorView, LoadMore } from "@/shared/ui/state-views";
import { runErrorKey } from "@/shared/workspace/run-errors";
import { usePendingRuns, useRecipes, useRuns, type Run } from "./api";
import { projectHref } from "./workspace-layout";

function duration(run: Run): string | null {
  if (!run.started_at || !run.finished_at) return null;
  const s = Math.max(0, Math.round((Date.parse(run.finished_at) - Date.parse(run.started_at)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/**
 * Runs of the project (or of one recipe), newest first. Polls the in-flight runs every 2 s (usePendingRuns) and refreshes when one changes; a succeeded run
 * links its derived output, a failed one shows the Korean sentence for the server's error code.
 */
export function RunsList({ projectId, recipeId, limit, caption }: { projectId: string; recipeId?: string; limit?: number; caption: string }) {
  const t = useTranslations();
  const runs = useRuns(projectId, { ...(recipeId ? { recipe_id: recipeId } : {}), ...(limit ? { limit } : {}) });
  const recipes = useRecipes(projectId);
  const shownPending = flattenPages(runs.data).some((r) => r.status === "QUEUED" || r.status === "RUNNING");
  usePendingRuns(projectId, recipeId, { listed: shownPending });
  const names = new Map((recipes.data?.items ?? []).map((r) => [r.recipe_id, r.name]));
  if (runs.isPending) return <DelayedSkeleton lines={3} />;
  if (runs.isError) return <ErrorView error={runs.error} onRetry={() => void runs.refetch()} />;
  const rows = flattenPages(runs.data);
  return (
    <>
      <DataTable<Run>
        caption={caption}
        dense
        rows={rows}
        rowKey={(r) => r.run_id}
        empty={<EmptyState icon={Play} title={t("workspace.runs.empty")} description={t("workspace.runs.emptyHint")} />}
        columns={[
          { key: "status", header: t("workspace.runs.status"), cell: (r) => <WorkspaceRunBadge status={r.status} /> },
          ...(recipeId
            ? []
            : [
                {
                  key: "recipe",
                  header: t("workspace.runs.recipe"),
                  cell: (r: Run) =>
                    names.has(r.recipe_id) ? (
                      <Link href={`${projectHref(projectId, "recipes")}/${r.recipe_id}`} className="font-medium text-fg underline-offset-4 hover:underline">
                        {names.get(r.recipe_id)}
                      </Link>
                    ) : (
                      <span className="text-fg-muted">{t("workspace.runs.deletedRecipe")}</span>
                    ),
                },
              ]),
          { key: "version", header: t("workspace.runs.version"), cell: (r) => <span className="num font-mono text-mono">v{r.recipe_version}</span> },
          { key: "queued", header: t("workspace.runs.queuedAt"), numeric: true, cell: (r) => <DateTime value={r.queued_at} /> },
          { key: "took", header: t("workspace.runs.took"), numeric: true, cell: (r) => duration(r) ?? "—" },
          {
            key: "rows",
            header: t("workspace.runs.rows"),
            numeric: true,
            cell: (r) => (r.input_rows !== null && r.output_rows !== null ? t("workspace.runs.rowsValue", { input: r.input_rows, output: r.output_rows }) : "—"),
          },
          {
            key: "result",
            header: t("workspace.runs.result"),
            cell: (r) =>
              r.status === "SUCCEEDED" && r.output_id ? (
                <Link href={`${projectHref(projectId, "outputs")}/${r.output_id}`} className="font-medium text-fg underline-offset-4 hover:underline">
                  {t("workspace.runs.openOutput")}
                </Link>
              ) : r.status === "FAILED" ? (
                <span className="break-words text-small text-danger">{t(runErrorKey(r.error))}</span>
              ) : (
                <span className="text-fg-muted">—</span>
              ),
          },
        ]}
      />
      {limit ? null : <LoadMore hasNextPage={runs.hasNextPage} isFetchingNextPage={runs.isFetchingNextPage} fetchNextPage={runs.fetchNextPage} />}
    </>
  );
}
