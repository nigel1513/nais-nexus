"use client";
import { Button, cn } from "@nais/ui";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircle, Maximize2, Minimize2, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useWorkspace } from "@/features/workspace/workspace-layout";
import { PanelHead } from "@/shared/ui/work-hero";
import type { NotebookError } from "./open-notebook";

type Opened = { location: string } | { error: NotebookError };

/** POST /notebooks-open: the folder is prepared on the web server; anything but a JupyterLab address is an error. */
async function openProjectNotebook(projectId: string): Promise<Opened> {
  try {
    const res = await fetch(`/notebooks-open?project=${encodeURIComponent(projectId)}`, { method: "POST", cache: "no-store" });
    const body = (await res.json()) as { location?: unknown; error?: unknown };
    if (res.ok && typeof body.location === "string" && body.location.startsWith("/notebooks/")) return { location: body.location };
    return { error: body.error === "forbidden" || body.error === "archived" ? body.error : "unavailable" };
  } catch {
    return { error: "unavailable" };
  }
}

/**
 * Workspace 노트북 tab (M07-lite): the caller's folder of this project in the shared JupyterLab, in a frame inside the
 * portal. Once JupyterLab is ready the page scrolls so the tab's title sits under the top bar and the frame takes the
 * rest of the window; "넓게 보기" lets the frame fill the whole window (Esc or the same button brings the workspace back).
 */
export function NotebookTab() {
  const t = useTranslations();
  const { project, archived } = useWorkspace();
  const [expanded, setExpanded] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const blocked: NotebookError | null = archived ? "archived" : project.my_role ? null : "forbidden";
  const opened = useQuery({
    queryKey: ["notebook-open", project.project_id],
    queryFn: () => openProjectNotebook(project.project_id),
    enabled: !blocked,
    retry: false,
    staleTime: Infinity,
    gcTime: 0, // the address carries the Jupyter token: not kept after the tab is left
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const error = blocked ?? (opened.data && "error" in opened.data ? opened.data.error : null);
  const location = !blocked && opened.data && "location" in opened.data ? opened.data.location : null;

  // JupyterLab is the work area here: bring it up past the summary band as soon as it can be shown.
  useEffect(() => {
    if (location) sectionRef.current?.scrollIntoView?.({ block: "start", behavior: "instant" });
  }, [location]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded]);

  const frameSize = expanded ? "min-h-0 flex-1" : "h-[max(32rem,calc(100dvh-11.5rem))]";
  return (
    <section ref={sectionRef} aria-labelledby="ws-notebook-title" className={cn("flex scroll-mt-16 flex-col", expanded && "fixed inset-0 z-dialog bg-bg p-3")}>
      <PanelHead
        id="ws-notebook-title"
        crumb={t("workspace.tabs.notebook")}
        title={t("notebooks.tab.title")}
        right={
          location ? (
            <Button variant="secondary" size="sm" aria-pressed={expanded} onClick={() => setExpanded((v) => !v)}>
              {expanded ? <Minimize2 aria-hidden="true" strokeWidth={1.75} /> : <Maximize2 aria-hidden="true" strokeWidth={1.75} />}
              {t(expanded ? "notebooks.tab.collapse" : "notebooks.tab.expand")}
            </Button>
          ) : null
        }
        className="mb-3"
      />
      {expanded ? null : <p className="mb-3 max-w-3xl text-small text-fg-muted">{t("notebooks.tab.hint")}</p>}
      {error ? (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-warning-line bg-warning-soft p-3 text-small text-fg">
          <TriangleAlert aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="font-medium">{t(`notebooks.error.${error}`)}</p>
            {error === "unavailable" ? <p className="text-fg-muted">{t("notebooks.error.unavailableHint")}</p> : null}
          </div>
          {error === "unavailable" ? (
            <Button variant="secondary" size="sm" disabled={opened.isFetching} onClick={() => void opened.refetch()}>
              {t("notebooks.retry")}
            </Button>
          ) : null}
        </div>
      ) : location ? (
        <iframe src={location} title={t("notebooks.tab.frame", { project: project.name })} referrerPolicy="no-referrer" className={cn("w-full rounded-md border border-border bg-white", frameSize)} />
      ) : (
        <div role="status" className={cn("flex flex-col items-center justify-center gap-2 rounded-md border border-border text-small text-fg-muted", frameSize)}>
          <LoaderCircle aria-hidden="true" strokeWidth={1.75} className="size-5 motion-safe:animate-spin" />
          <p className="font-medium text-fg">{t("notebooks.tab.preparing")}</p>
          <p>{t("notebooks.tab.preparingHint")}</p>
        </div>
      )}
    </section>
  );
}
