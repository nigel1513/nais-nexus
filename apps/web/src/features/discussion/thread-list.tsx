"use client";
import { Badge, Button, cn, EmptyState, FormField, Input, Textarea, focusRing } from "@nais/ui";
import { MessageSquare } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { flattenPages } from "@/shared/api/pagination";
import { useErrorText } from "@/shared/api/use-error-text";
import { formatDate } from "@/shared/lib/format";
import { DelayedSkeleton, ErrorView, LoadMore } from "@/shared/ui/state-views";
import { notify } from "@/shared/ui/toast";
import { useCreateThread, useThreads, type Thread, type ThreadScope, type ThreadSelector } from "./api";

/**
 * Threads of one target (or one project), most recent activity first. A row opens the thread; resolved threads stay in
 * the list with a 해결됨 tag. Shared by the Data Card and the project's 토론 tab.
 */
export function ThreadList({ selector, onOpen, showScope = false }: { selector: ThreadSelector; onOpen: (thread: Thread) => void; /** Tag each row with what it is about (project lists mix project, recipe and output threads). */ showScope?: boolean }) {
  const t = useTranslations();
  const threads = useThreads(selector);
  const rows = flattenPages(threads.data);
  if (threads.isPending) return <DelayedSkeleton lines={3} />;
  if (threads.isError) return <ErrorView error={threads.error} onRetry={() => void threads.refetch()} />;
  if (!rows.length) return <EmptyState icon={MessageSquare} title={t("discussion.empty")} description={t("discussion.emptyHint")} />;
  return (
    <>
      <ul className="flex flex-col divide-y divide-border border-y border-border">
        {rows.map((th) => (
          <li key={th.thread_id}>
            <button
              type="button"
              onClick={() => onOpen(th)}
              className={cn("flex w-full min-w-0 flex-col gap-1 px-3 py-3 text-left transition-colors duration-[var(--dur-fast)] hover:bg-bg-hover sm:flex-row sm:items-baseline sm:justify-between sm:gap-4", focusRing, "focus-visible:-outline-offset-2")}
            >
              <span className="flex min-w-0 items-baseline gap-2">
                {showScope ? <Badge tone="neutral">{t(`enums.ThreadScope.${th.scope}`)}</Badge> : null}
                <span className="truncate font-medium text-fg">{th.title}</span>
                {th.resolved ? <Badge tone="success">{t("discussion.resolved")}</Badge> : null}
              </span>
              <span className="num shrink-0 text-small text-fg-muted">
                {t("discussion.rowMeta", { author: th.created_by_display_name, count: th.comment_count, date: formatDate(th.last_comment_at) })}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <LoadMore hasNextPage={threads.hasNextPage} isFetchingNextPage={threads.isFetchingNextPage} fetchNextPage={threads.fetchNextPage} />
    </>
  );
}

/** New thread: title and first comment (markdown). */
export function NewThreadForm({ scope, targetId, onCreated, onCancel }: { scope: ThreadScope; targetId: string; onCreated: (thread: Thread) => void; onCancel: () => void }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const create = useCreateThread();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const formId = useId();
  // The form opens on the reader's click: move focus into it (no autoFocus attribute).
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => titleRef.current?.focus(), []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !body.trim()) return;
    create.mutate({ scope, target_id: targetId, title: title.trim(), body }, { onSuccess: onCreated, onError: (err) => notify.error(errorText(err)) });
  };
  return (
    <form onSubmit={submit} aria-label={t("discussion.new")} className="flex flex-col gap-3 rounded-md border border-border bg-bg-panel p-4">
      <FormField id={`${formId}-title`} label={t("discussion.title")}>
        {(a11y) => <Input {...a11y} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} ref={titleRef} />}
      </FormField>
      <FormField id={`${formId}-body`} label={t("discussion.body")} hint={t("discussion.markdownHint")}>
        {(a11y) => <Textarea {...a11y} value={body} maxLength={10_000} rows={4} onChange={(e) => setBody(e.target.value)} />}
      </FormField>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={!title.trim() || !body.trim() || create.isPending}>
          {t("discussion.start")}
        </Button>
      </div>
    </form>
  );
}
