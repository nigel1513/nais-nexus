"use client";
import { Button } from "@nais/ui";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import { useThreads, type Thread, type ThreadScope, type ThreadSelector } from "@/features/discussion/api";
import { NewThreadForm, ThreadList } from "@/features/discussion/thread-list";
import { ThreadView } from "@/features/discussion/thread-view";
import { flattenPages } from "@/shared/api/pagination";
import { useMeData } from "@/shared/hooks/use-me";
import { useUrlQuery } from "@/shared/hooks/use-url-query";
import { PanelHead } from "@/shared/ui/work-hero";
import { useWorkspace } from "./workspace-layout";

/**
 * Threads of a selector with one open thread (`?thread=` keeps it linkable). Members start threads and reply; the
 * author or a project owner/admin resolves. An archived project's discussion is read-only.
 */
function DiscussionPanel({ selector, scope, targetId, crumb, title, showScope }: { selector: ThreadSelector; scope: ThreadScope; targetId: string; crumb: string; title: string; showScope?: boolean }) {
  const t = useTranslations();
  const me = useMeData();
  const { project, archived } = useWorkspace();
  const manager = project.my_role === "PROJECT_OWNER" || project.my_role === "PROJECT_ADMIN";
  const [params, setParams] = useUrlQuery();
  const [composing, setComposing] = useState(false);
  const [created, setCreated] = useState<Thread | null>(null);
  // Focus follows the reader's own clicks only: a deep link (?thread=) must not steal focus on load.
  const [moved, setMoved] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const threads = useThreads(selector);
  const rows = flattenPages(threads.data);
  const openId = params.get("thread");
  const open = openId ? (rows.find((r) => r.thread_id === openId) ?? (created?.thread_id === openId ? created : undefined)) : undefined;
  const openThread = (id: string) => {
    setMoved(true);
    setParams({ thread: id });
  };

  return (
    <section ref={sectionRef} aria-labelledby={titleId} tabIndex={-1} className="flex flex-col gap-4 outline-none">
      <PanelHead
        id={titleId}
        crumb={crumb}
        title={title}
        count={threads.data && !threads.hasNextPage ? rows.length : undefined}
        right={
          !open && !composing && !archived ? (
            <Button onClick={() => setComposing(true)}>
              <Plus aria-hidden="true" strokeWidth={1.75} />
              {t("discussion.new")}
            </Button>
          ) : null
        }
      />
      {open ? (
        <ThreadView
          thread={open}
          canModerate={open.created_by === me.user_id || manager}
          canReply={!archived}
          focusOnMount={moved}
          onBack={() => {
            setParams({ thread: null });
            sectionRef.current?.focus({ preventScroll: true });
          }}
        />
      ) : (
        <>
          {composing ? (
            <NewThreadForm
              scope={scope}
              targetId={targetId}
              onCancel={() => setComposing(false)}
              onCreated={(th) => {
                setCreated(th);
                setComposing(false);
                openThread(th.thread_id);
              }}
            />
          ) : null}
          {openId && threads.isSuccess ? (
            <p role="status" className="text-small text-fg-muted">
              {t("discussion.notFound")}
            </p>
          ) : null}
          <ThreadList selector={selector} onOpen={(th) => openThread(th.thread_id)} showScope={showScope} />
        </>
      )}
    </section>
  );
}

/** 토론 tab: every thread of the project (project, recipe and output threads); new threads are about the project. */
export function DiscussionTab() {
  const t = useTranslations();
  const { project } = useWorkspace();
  return (
    <DiscussionPanel
      selector={{ projectId: project.project_id }}
      scope="PROJECT"
      targetId={project.project_id}
      crumb={t("workspace.tabs.discussion")}
      title={t("workspace.discussion.title")}
      showScope
    />
  );
}

/** The discussion of one recipe or output, at the bottom of its page. */
export function TargetDiscussion({ scope, targetId }: { scope: "RECIPE" | "OUTPUT"; targetId: string }) {
  const t = useTranslations();
  return (
    <DiscussionPanel
      selector={{ scope, targetId }}
      scope={scope}
      targetId={targetId}
      crumb={t("workspace.tabs.discussion")}
      title={scope === "RECIPE" ? t("workspace.discussion.recipeTitle") : t("workspace.discussion.outputTitle")}
    />
  );
}
