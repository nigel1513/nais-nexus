"use client";
import { Button } from "@nais/ui";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useThreads, type Thread } from "@/features/discussion/api";
import { NewThreadForm, ThreadList } from "@/features/discussion/thread-list";
import { ThreadView } from "@/features/discussion/thread-view";
import { flattenPages } from "@/shared/api/pagination";
import { useMeData } from "@/shared/hooks/use-me";
import { useUrlQuery } from "@/shared/hooks/use-url-query";
import { PanelHead } from "@/shared/ui/work-hero";
import { sectionId } from "./section-nav";

/**
 * 토론 section of the Data Card: the dataset's threads, or one open thread (`?thread=` keeps it linkable). Anyone who
 * can see the dataset may start or join a thread; the author and the owner organization's steward may resolve it.
 */
export function DatasetDiscussion({ datasetId, steward, titleId }: { datasetId: string; steward: boolean; titleId: string }) {
  const t = useTranslations();
  const me = useMeData();
  const [params, setParams] = useUrlQuery();
  const [composing, setComposing] = useState(false);
  const [created, setCreated] = useState<Thread | null>(null);
  // Focus follows the reader's own clicks only: a deep link (?thread=) must not steal focus on load.
  const [moved, setMoved] = useState(false);
  const openThread = (id: string) => {
    setMoved(true);
    setParams({ thread: id });
  };
  const selector = { scope: "DATASET", targetId: datasetId } as const;
  const threads = useThreads(selector);
  const rows = flattenPages(threads.data);
  const openId = params.get("thread");
  // A thread just created may not be in the refetched list yet.
  const open = openId ? (rows.find((r) => r.thread_id === openId) ?? (created?.thread_id === openId ? created : undefined)) : undefined;

  return (
    <>
      <PanelHead
        id={titleId}
        crumb={t("data.card.hero.discussionCrumb")}
        title={t("data.card.discussionTitle")}
        count={threads.data ? rows.length : undefined}
        right={
          !open && !composing ? (
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
          canModerate={open.created_by === me.user_id || steward}
          focusOnMount={moved}
          onBack={() => {
            setParams({ thread: null });
            document.getElementById(sectionId("discussion"))?.focus({ preventScroll: true });
          }}
        />
      ) : (
        <>
          {composing ? (
            <NewThreadForm
              scope="DATASET"
              targetId={datasetId}
              onCancel={() => setComposing(false)}
              onCreated={(th) => {
                setCreated(th);
                setComposing(false);
                openThread(th.thread_id);
              }}
            />
          ) : null}
          <ThreadList selector={selector} onOpen={(th) => openThread(th.thread_id)} />
        </>
      )}
    </>
  );
}
