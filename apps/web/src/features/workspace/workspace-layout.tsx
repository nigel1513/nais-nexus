"use client";
import { ConfirmDialog, Menu, cn, focusRing } from "@nais/ui";
import { Archive, Ellipsis, Globe, Lock, Pencil } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useArchiveProject, useGetProject } from "@/features/projects/api";
import { asApiError } from "@/shared/api/errors";
import type { Project } from "@/shared/api/types";
import { useErrorText } from "@/shared/api/use-error-text";
import { useBreadcrumbs, type Crumb } from "@/shared/ui/breadcrumbs";
import { DateTime } from "@/shared/ui/date-text";
import { BandTag, SummaryBand } from "@/shared/ui/screen-v2";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { notify } from "@/shared/ui/toast";
import { PublicSummary } from "./overview-tab";

/** Workspace tabs, in order; each is its own route under /commons/projects/{id}. Task 15 adds 연구노트 here. */
export const WORKSPACE_TABS = ["overview", "data", "recipes", "outputs", "discussion", "members", "activity"] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];
/** Old `?tab=` links of the single-page project detail. */
const LEGACY_TABS: Record<string, WorkspaceTab> = { members: "members", data: "data", activity: "activity" };

export const projectHref = (projectId: string, tab: WorkspaceTab = "overview") => `/commons/projects/${projectId}${tab === "overview" ? "" : `/${tab}`}`;

export type Workspace = {
  project: Project;
  /** OWNER/ADMIN of an ACTIVE project: edit, members. */
  manager: boolean;
  /** OWNER of an ACTIVE project: visibility, archive. */
  owner: boolean;
  /** ACTIVE member other than VIEWER: inputs, recipes, runs, uploads, publish requests. */
  canWrite: boolean;
  archived: boolean;
  /** A detail page under a tab (a recipe, an output) adds its own crumb after the tab's. */
  setDetailCrumb: (crumb: Crumb | null) => void;
};

const WorkspaceContext = createContext<Workspace | null>(null);

export function useWorkspace(): Workspace {
  const ws = useContext(WorkspaceContext);
  if (!ws) throw new Error("useWorkspace outside WorkspaceLayout");
  return ws;
}

/** A detail page's crumb (cleared when it unmounts). */
export function useDetailCrumb(crumb: Crumb | null) {
  const { setDetailCrumb } = useWorkspace();
  const key = crumb ? JSON.stringify(crumb) : "";
  useEffect(() => {
    setDetailCrumb(key ? (JSON.parse(key) as Crumb) : null);
    return () => setDetailCrumb(null);
  }, [key, setDetailCrumb]);
}

function tabOf(pathname: string, projectId: string): WorkspaceTab {
  const rest = pathname.slice(`/commons/projects/${projectId}`.length).split("/")[1] ?? "";
  return (WORKSPACE_TABS as readonly string[]).includes(rest) ? (rest as WorkspaceTab) : "overview";
}

/**
 * Project workspace frame: the summary band (name, status, my role, key facts, edit/archive), the tab strip as links
 * (개요 · 데이터 · 변환 · 산출물 · 토론 · 구성원 · 활동) and the current tab's page. Non-members of a PUBLIC project see
 * its public summary only.
 */
export function WorkspaceLayout({ projectId, children }: { projectId: string; children: ReactNode }) {
  const t = useTranslations();
  const q = useGetProject(projectId);
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const tab = tabOf(pathname, projectId);
  const legacy = tab === "overview" ? LEGACY_TABS[params.get("tab") ?? ""] : undefined;
  const [detail, setDetailCrumb] = useState<Crumb | null>(null);

  useEffect(() => {
    if (legacy) router.replace(projectHref(projectId, legacy));
  }, [legacy, projectId, router]);

  const crumbs: Crumb[] = q.data
    ? [
        { label: q.data.name, href: projectHref(projectId) },
        ...(tab !== "overview" ? [{ label: t(`workspace.tabs.${tab}`), href: projectHref(projectId, tab) }] : []),
        ...(detail ? [detail] : []),
      ]
    : [];
  useBreadcrumbs(crumbs);

  if (q.isPending) return <DelayedSkeleton lines={5} />;
  if (q.isError) {
    if (asApiError(q.error).code === "FORBIDDEN") return <PublicSummary projectId={projectId} />;
    return <ErrorView error={q.error} onRetry={() => void q.refetch()} />;
  }
  const p = q.data;
  const archived = p.status === "ARCHIVED";
  const ws: Workspace = {
    project: p,
    manager: (p.my_role === "PROJECT_OWNER" || p.my_role === "PROJECT_ADMIN") && !archived,
    owner: p.my_role === "PROJECT_OWNER" && !archived,
    canWrite: !!p.my_role && p.my_role !== "VIEWER" && !archived,
    archived,
    setDetailCrumb,
  };

  return (
    <WorkspaceContext.Provider value={ws}>
      <WorkspaceBand ws={ws} />
      {archived ? (
        <p role="status" className="mb-6 flex items-center gap-2 rounded-md border border-warning-line bg-warning-soft px-3 py-2 text-small text-fg">
          <Archive aria-hidden="true" className="size-4 shrink-0 text-warning" strokeWidth={1.75} />
          {t("projects.detail.archivedBanner")}
        </p>
      ) : null}
      <nav aria-label={t("workspace.tabsLabel")} className="mb-6 border-b border-border">
        <ul className="-mb-px flex gap-6 overflow-x-auto [scrollbar-width:none]">
          {WORKSPACE_TABS.map((k) => {
            const current = k === tab;
            return (
              <li key={k} className="shrink-0">
                <Link
                  href={projectHref(projectId, k)}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "relative flex h-10 items-center gap-1.5 whitespace-nowrap rounded-sm text-body font-medium text-fg-muted hover:text-fg",
                    "after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-t-sm",
                    current ? "text-fg after:bg-fg" : "after:bg-transparent",
                    focusRing,
                    "focus-visible:-outline-offset-2",
                  )}
                >
                  {t(`workspace.tabs.${k}`)}
                  {k === "members" && p.member_count !== undefined ? <span className="num rounded-sm bg-bg-active px-1.5 text-caption text-fg-muted">{p.member_count}</span> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      {children}
    </WorkspaceContext.Provider>
  );
}

function WorkspaceBand({ ws }: { ws: Workspace }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const router = useRouter();
  const { project: p, manager, owner, archived } = ws;
  const archive = useArchiveProject(p.project_id);
  const [confirming, setConfirming] = useState(false);
  const lead = p.organizations.find((o) => o.role === "LEAD");
  return (
    <>
      <SummaryBand
        label={t("projects.detail.summary")}
        context={[t("projects.detail.context"), lead?.name ? t("projects.detail.leadBy", { org: lead.name }) : null]}
        title={p.name}
        tags={
          <>
            <BandTag tone={archived ? "warn" : "ok"}>{t(`enums.ProjectStatus.${p.status}`)}</BandTag>
            <BandTag icon={p.visibility === "PUBLIC" ? <Globe aria-hidden="true" strokeWidth={1.75} /> : <Lock aria-hidden="true" strokeWidth={1.75} />}>
              {t(`enums.ProjectVisibility.${p.visibility}`)}
            </BandTag>
            {p.my_role ? <BandTag tone="accent">{t("projects.detail.myRole", { role: t(`enums.ProjectRole.${p.my_role}`) })}</BandTag> : null}
          </>
        }
        actions={
          manager || owner ? (
            <>
              {manager ? (
                <button type="button" className={cn("sv-hb sv-hb-w", focusRing)} onClick={() => router.push(`${projectHref(p.project_id)}?edit=1`)}>
                  <Pencil aria-hidden="true" strokeWidth={1.75} />
                  {t("common.edit")}
                </button>
              ) : null}
              {owner ? (
                <Menu.Root>
                  <Menu.Trigger aria-label={t("projects.detail.more")} className={cn("sv-hb sv-hb-g sv-hb-i", focusRing)}>
                    <Ellipsis aria-hidden="true" strokeWidth={1.75} />
                  </Menu.Trigger>
                  <Menu.Content align="end">
                    <Menu.Item tone="danger" icon={<Archive aria-hidden="true" />} onClick={() => setConfirming(true)}>
                      {t("projects.detail.archiveEllipsis")}
                    </Menu.Item>
                  </Menu.Content>
                </Menu.Root>
              ) : null}
            </>
          ) : null
        }
        facts={[
          { label: t("projects.detail.factMembers"), value: p.member_count ?? "—", unit: p.member_count !== undefined ? t("projects.detail.unitPeople") : undefined },
          { label: t("projects.detail.factOrgs"), value: p.organizations.length, unit: t("projects.detail.unitOrgs") },
          {
            label: t("projects.detail.period"),
            kind: p.start_date || p.end_date ? "mono" : "text",
            value: p.start_date || p.end_date ? `${p.start_date ?? "…"} – ${p.end_date ?? "…"}` : t("projects.detail.noPeriod"),
          },
          { label: t("projects.detail.updatedAt"), kind: "mono", value: <DateTime value={p.updated_at ?? p.created_at} dateOnly /> },
        ]}
      />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("projects.detail.archiveTitle")}
        description={t("projects.detail.archiveWarning")}
        confirmLabel={t("projects.detail.archive")}
        cancelLabel={t("common.cancel")}
        closeLabel={t("common.close")}
        destructive
        pending={archive.isPending}
        onConfirm={() =>
          archive.mutate(undefined, {
            onSuccess: () => {
              setConfirming(false);
              notify.success(t("projects.detail.archived"));
            },
            onError: (e) => {
              setConfirming(false);
              notify.error(errorText(e));
            },
          })
        }
      />
    </>
  );
}
