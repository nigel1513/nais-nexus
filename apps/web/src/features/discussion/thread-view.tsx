"use client";
import { Avatar, Badge, Button, FormField, Textarea } from "@nais/ui";
import { ArrowLeft } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Markdown } from "@/features/catalog/components/markdown";
import { flattenPages } from "@/shared/api/pagination";
import { useErrorText } from "@/shared/api/use-error-text";
import { DateTime } from "@/shared/ui/date-text";
import { DelayedSkeleton, ErrorView, LoadMore } from "@/shared/ui/state-views";
import { notify } from "@/shared/ui/toast";
import { useAddComment, useComments, useUpdateThread, type Thread } from "./api";

/**
 * One thread: its comments oldest first (markdown), a reply box, and 해결 / 다시 열기 for whoever may moderate it (the
 * author; a project owner or admin; the owner organization's data steward for dataset threads — the server decides).
 */
export function ThreadView({
  thread,
  onBack,
  canModerate,
  canReply = true,
  focusOnMount = false,
}: {
  thread: Thread;
  onBack: () => void;
  canModerate: boolean;
  /** false where the discussion is read-only (an archived project). */
  canReply?: boolean;
  focusOnMount?: boolean;
}) {
  const t = useTranslations();
  const errorText = useErrorText();
  const comments = useComments(thread.thread_id);
  const update = useUpdateThread(thread);
  const titleId = useId();
  const rows = flattenPages(comments.data);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusOnMount) heading.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the thread opens
  }, [thread.thread_id]);

  return (
    <article aria-labelledby={titleId} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2.5 self-start">
            <ArrowLeft aria-hidden="true" strokeWidth={1.75} />
            {t("discussion.backToList")}
          </Button>
          <h3 id={titleId} ref={heading} tabIndex={-1} className="break-keep outline-none text-heading font-semibold text-fg">
            {thread.title}
          </h3>
          <p className="flex flex-wrap items-center gap-x-2 text-small text-fg-muted">
            {thread.resolved ? <Badge tone="success">{t("discussion.resolved")}</Badge> : null}
            <span>{thread.created_by_display_name}</span>
            <span aria-hidden="true">·</span>
            <DateTime value={thread.created_at} />
          </p>
        </div>
        {canModerate && canReply ? (
          <Button
            disabled={update.isPending}
            onClick={() => update.mutate({ resolved: !thread.resolved }, { onError: (err) => notify.error(errorText(err)) })}
          >
            {thread.resolved ? t("discussion.reopen") : t("discussion.resolve")}
          </Button>
        ) : null}
      </div>
      {comments.isPending ? (
        <DelayedSkeleton lines={3} />
      ) : comments.isError ? (
        <ErrorView error={comments.error} onRetry={() => void comments.refetch()} />
      ) : (
        <ol aria-label={t("discussion.comments")} className="flex flex-col divide-y divide-border border-y border-border">
          {rows.map((c) => (
            <li key={c.comment_id} className="flex gap-3 py-3.5">
              <Avatar name={c.author_display_name} size={24} decorative />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <p className="flex flex-wrap items-baseline gap-x-2 text-small">
                  <span className="font-medium text-fg">{c.author_display_name}</span>
                  <span className="num text-fg-muted">
                    <DateTime value={c.created_at} />
                  </span>
                  {c.edited_at ? <span className="text-fg-muted">{t("discussion.edited")}</span> : null}
                </p>
                <div className="[&_.text-long]:text-body">
                  <Markdown source={c.body} nestedHeadings />
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
      <LoadMore hasNextPage={comments.hasNextPage} isFetchingNextPage={comments.isFetchingNextPage} fetchNextPage={comments.fetchNextPage} />
      {canReply ? <ReplyForm thread={thread} /> : null}
    </article>
  );
}

function ReplyForm({ thread }: { thread: Thread }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const add = useAddComment(thread);
  const [body, setBody] = useState("");
  const id = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    add.mutate({ body }, { onSuccess: () => setBody(""), onError: (err) => notify.error(errorText(err)) });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <FormField id={id} label={t("discussion.reply")} hint={t("discussion.markdownHint")}>
        {(a11y) => <Textarea {...a11y} value={body} maxLength={10_000} rows={3} onChange={(e) => setBody(e.target.value)} />}
      </FormField>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={!body.trim() || add.isPending}>
          {t("discussion.send")}
        </Button>
      </div>
    </form>
  );
}
