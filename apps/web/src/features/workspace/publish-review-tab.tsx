"use client";
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, EmptyState, FormField, Radio, RadioGroup, SegmentedControl, Textarea } from "@nais/ui";
import { Globe, Inbox } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { flattenPages } from "@/shared/api/pagination";
import type { Schemas } from "@/shared/api/types";
import { useErrorText } from "@/shared/api/use-error-text";
import { useMeData } from "@/shared/hooks/use-me";
import { PublishRequestBadge } from "@/shared/ui/badges";
import { DateTime } from "@/shared/ui/date-text";
import { DelayedSkeleton, ErrorView, LoadMore } from "@/shared/ui/state-views";
import { notify } from "@/shared/ui/toast";
import { useDecidePublishRequest, usePublishRequests, type PublishRequest } from "./api";
import { PublishRequestView } from "./output-detail";

type Filter = "pending" | "all";

/**
 * 공개 요청 (data stewards): requests to publish a project output to the hub that need my organization's approval.
 * Each organization's slot is decided once; a requester never decides their own request; a rejection needs a reason.
 */
export function PublishReviewTab() {
  const t = useTranslations();
  const me = useMeData();
  const [filter, setFilter] = useState<Filter>("pending");
  const requests = usePublishRequests({ role: "reviewer", ...(filter === "pending" ? { status: ["PENDING"] } : {}) });
  const [deciding, setDeciding] = useState<PublishRequest | null>(null);
  const rows = flattenPages(requests.data);
  const myOrg = me.organization.organization_id;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <SegmentedControl
          aria-label={t("workspace.review.filter")}
          value={filter}
          onValueChange={(v) => setFilter(v as Filter)}
          items={[
            { value: "pending", label: t("workspace.review.pending") },
            { value: "all", label: t("workspace.review.all") },
          ]}
        />
      </div>
      {requests.isPending ? (
        <DelayedSkeleton />
      ) : requests.isError ? (
        <ErrorView error={requests.error} onRetry={() => void requests.refetch()} />
      ) : rows.length ? (
        <ul aria-label={t("workspace.review.listLabel")} className="flex flex-col divide-y divide-border border-y border-border">
          {rows.map((r) => {
            const slot = r.approvals.find((a) => a.organization_id === myOrg);
            const own = r.created_by === me.user_id;
            const open = r.status === "PENDING" && !!slot && slot.decision === null;
            return (
              <li key={r.request_id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-fg">{r.output_title ?? r.output_id}</span>
                    <PublishRequestBadge status={r.status} />
                  </p>
                  <p className="text-small text-fg-muted">
                    {r.project_name} · <DateTime value={r.created_at} /> · {t("workspace.review.slots", { decided: r.approvals.filter((a) => a.decision).length, total: r.approvals.length })}
                  </p>
                  {r.failure_reason ? <p className="text-small text-danger">{t("workspace.publish.failed", { reason: r.failure_reason })}</p> : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {slot?.decision ? <Badge tone={slot.decision === "APPROVE" ? "success" : "danger"}>{t("workspace.review.mine", { decision: t(`enums.PublishDecision.${slot.decision}`) })}</Badge> : null}
                  {r.published_dataset_id ? (
                    <Link href={`/commons/data/${r.published_dataset_id}`} className="inline-flex items-center gap-1 text-small font-medium text-fg underline-offset-4 hover:underline">
                      <Globe aria-hidden="true" strokeWidth={1.75} className="size-3.5" />
                      {t("workspace.publish.openDataset")}
                    </Link>
                  ) : null}
                  {open && own ? <span className="text-small text-fg-muted">{t("workspace.review.own")}</span> : null}
                  {open && !own ? (
                    <Button variant="primary" size="sm" onClick={() => setDeciding(r)} aria-label={t("workspace.review.decideLabel", { title: r.output_title ?? "" })}>
                      {t("workspace.review.decide")}
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState icon={Inbox} title={filter === "pending" ? t("workspace.review.empty") : t("workspace.review.emptyAll")} description={t("workspace.review.emptyHint")} />
      )}
      <LoadMore hasNextPage={requests.hasNextPage} isFetchingNextPage={requests.isFetchingNextPage} fetchNextPage={requests.fetchNextPage} />
      {deciding ? <DecideDialog request={deciding} onClose={() => setDeciding(null)} /> : null}
    </div>
  );
}

function DecideDialog({ request, onClose }: { request: PublishRequest; onClose: () => void }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const id = useId();
  const decide = useDecidePublishRequest(request.request_id);
  const [decision, setDecision] = useState<Schemas["PublishDecision"] | "">("");
  const [comment, setComment] = useState("");
  const [tried, setTried] = useState(false);
  const needsComment = decision === "REJECT" && !comment.trim();
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent closeLabel={t("common.close")} className="max-w-2xl">
        <DialogTitle>{t("workspace.review.title")}</DialogTitle>
        <DialogDescription>{t("workspace.review.description", { title: request.output_title ?? "", project: request.project_name ?? "" })}</DialogDescription>
        <form
          className="mt-4 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setTried(true);
            if (!decision || needsComment) return;
            decide.mutate(
              { decision, ...(comment.trim() ? { comment: comment.trim() } : {}) },
              {
                onSuccess: (r) => {
                  notify.success(r.status === "PENDING" ? t("workspace.review.recorded") : t(`workspace.review.done.${r.status}`));
                  onClose();
                },
                onError: (err) => notify.error(errorText(err)),
              },
            );
          }}
        >
          <PublishRequestView request={request} />
          <fieldset className="flex flex-col gap-2">
            <legend id={`${id}-decision`} className="mb-1.5 text-small font-medium text-fg">
              {t("workspace.publish.decision")}
            </legend>
            <RadioGroup aria-labelledby={`${id}-decision`} value={decision} onValueChange={(v) => setDecision(v as Schemas["PublishDecision"])} orientation="horizontal">
              <Radio value="APPROVE" label={t("enums.PublishDecision.APPROVE")} />
              <Radio value="REJECT" label={t("enums.PublishDecision.REJECT")} />
            </RadioGroup>
          </fieldset>
          <FormField
            id={`${id}-comment`}
            label={t("workspace.publish.comment")}
            hint={t("workspace.review.commentHint")}
            required={decision === "REJECT"}
            requiredLabel={t("common.required")}
            error={tried && needsComment ? t("workspace.review.commentRequired") : undefined}
          >
            {(a11y) => <Textarea {...a11y} rows={3} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />}
          </FormField>
          <DialogFooter className="mt-2">
            <Button variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={!decision || decide.isPending}>
              {t("workspace.review.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
