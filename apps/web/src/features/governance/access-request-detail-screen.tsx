"use client";
import { Avatar, buttonClass, PathText, Tag } from "@nais/ui";
import { Download } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef, type ReactNode } from "react";
import { useGetDatasetPolicy } from "@/features/catalog/api";
import { useOrgNames } from "@/features/organizations/api";
import { flattenPages } from "@/shared/api/pagination";
import type { AccessRequest } from "@/shared/api/types";
import { useMeData } from "@/shared/hooks/use-me";
import { AccessLevelBadge, GrantStatusBadge, RequestStatusBadge } from "@/shared/ui/badges";
import { useBreadcrumbs } from "@/shared/ui/breadcrumbs";
import { DateTime, ExpiryText } from "@/shared/ui/date-text";
import { PageHeader } from "@/shared/ui/page-header";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { useGetAccessRequest, useListAccessGrants, useStartAccessReview } from "./api";
import { Person, submittedAt } from "./components/request-meta";
import { ResubmitForm, WithdrawAction } from "./components/requester-actions";
import { ReviewActions } from "./components/review-actions";

const REVIEWABLE = ["SUBMITTED", "UNDER_REVIEW"];
const SENSITIVE_MAX_DAYS = 30;
const OPEN = ["SUBMITTED", "UNDER_REVIEW", "CHANGE_REQUESTED"];

/** Label | value row of a definition list; the dd follows its dt directly. */
function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 border-b border-border py-2 last:border-b-0 sm:gap-4">
      <dt className="w-20 shrink-0 pt-px text-small text-fg-muted sm:w-36">{term}</dt>
      <dd className="min-w-0 flex-1 text-body text-fg">{children}</dd>
    </div>
  );
}

/** Right-rail panel: caption title + content, 1px border (spec §5 detail template). */
function Panel({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-md border border-border bg-bg-panel p-4">
      <h2 id={id} className="mb-3 text-small font-medium leading-6 text-fg">
        {title}
      </h2>
      {children}
    </section>
  );
}

function RailFacts({ children }: { children: ReactNode }) {
  return <dl className="mb-4 flex flex-col gap-2 text-small">{children}</dl>;
}
function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-fg-muted">{term}</dt>
      <dd className="num text-right text-fg">{children}</dd>
    </div>
  );
}

function History({ request }: { request: AccessRequest }) {
  const t = useTranslations();
  const items = request.history ?? [];
  const requester = request.requester_display_name ?? t("access.detail.byRequester");
  return (
    <ol className="flex flex-col">
      {items.map((h, i) => {
        const byRequester = h.by_user_id === request.requester_user_id;
        const actor = byRequester ? requester : t("access.detail.byReviewer");
        return (
          <li key={`${h.status}-${h.at}-${i}`} className="relative flex gap-3 pb-5 last:pb-0">
            {i < items.length - 1 ? <span aria-hidden="true" className="absolute bottom-0 left-3 top-6 w-px -translate-x-1/2 bg-border" /> : null}
            <Avatar name={actor} size={24} decorative />
            <div className="min-w-0 flex-1">
              <p className="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1 text-small leading-6">
                <span className="font-medium text-fg">{actor}</span>
                <RequestStatusBadge status={h.status} />
                <span className="num text-fg-muted sm:ml-auto">
                  <DateTime value={h.at} />
                </span>
              </p>
              {/* Plain text only: user input is never rendered as HTML/Markdown (M10 §16). */}
              {h.comment ? <p className="mt-2 whitespace-pre-wrap break-words rounded-md border border-border bg-bg-subtle px-3 py-2 text-body text-fg">{h.comment}</p> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function AccessRequestDetailScreen({ accessRequestId }: { accessRequestId: string }) {
  const t = useTranslations();
  const me = useMeData();
  const orgNames = useOrgNames();
  const q = useGetAccessRequest(accessRequestId);
  useBreadcrumbs(q.data ? [{ label: q.data.dataset_title ?? q.data.dataset_id }] : []);
  const r = q.data;
  const policy = useGetDatasetPolicy(r?.dataset_id ?? "", { enabled: !!r });
  const startReview = useStartAccessReview(accessRequestId);
  const started = useRef(false);
  const isRequester = !!r && r.requester_user_id === me.user_id;
  const isReviewer =
    !!r && !isRequester && me.organization.organization_id === r.owner_organization_id && me.org_roles.includes("DATA_STEWARD");
  const grants = useListAccessGrants({ role: "subject", dataset_id: r?.dataset_id }, { enabled: !!r && isRequester && r.status === "APPROVED" });
  const grant = flattenPages(grants.data).find((g) => g.access_grant_id === r?.access_grant_id);

  useEffect(() => {
    // D-025: GET never changes state; the reviewer's screen calls start-review once. Failure keeps the screen as is.
    if (r && isReviewer && r.status === "SUBMITTED" && !started.current) {
      started.current = true;
      startReview.mutate(undefined, { onError: () => undefined });
    }
  }, [r, isReviewer, startReview]);

  if (q.isPending) return <DelayedSkeleton lines={6} />;
  if (q.isError) return <ErrorView error={q.error} onRetry={() => void q.refetch()} />;
  const req = q.data;
  // M02: SENSITIVE data is never granted for more than 30 days, regardless of the stored policy value.
  const policyMax = policy.data?.max_grant_days ?? req.requested_days;
  const maxDays = policy.data?.access_level === "SENSITIVE" ? Math.min(policyMax, SENSITIVE_MAX_DAYS) : policyMax;
  const requesterName = req.requester_display_name ?? req.requester_user_id;
  const requesterOrg = orgNames[req.requester_organization_id];
  const reviewable = isReviewer && REVIEWABLE.includes(req.status);

  return (
    <>
      <PageHeader
        title={req.dataset_title ?? req.dataset_id}
        description={t("access.detail.subtitle", { name: requesterName })}
        meta={
          <>
            <RequestStatusBadge status={req.status} />
            <span>
              {t("access.columns.submitted")}{" "}
              <span className="num">
                <DateTime value={submittedAt(req)} />
              </span>
            </span>
            <PathText value={req.access_request_id} copyLabel={t("access.detail.copyId")} copiedLabel={t("common.copied")} className="text-fg-muted" />
          </>
        }
      />
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-8 lg:pt-4">
          <section aria-labelledby="request-summary">
            <h2 id="request-summary" className="mb-2 text-heading text-fg">
              {t("access.detail.summary")}
            </h2>
            <dl className="border-t border-border">
              <Row term={t("access.columns.dataset")}>
                <Link href={`/commons/data/${req.dataset_id}`} className="font-medium text-fg underline underline-offset-4 decoration-border-strong hover:decoration-fg">
                  {req.dataset_title ?? req.dataset_id}
                </Link>
              </Row>
              <Row term={t("access.columns.project")}>{req.project_name ?? req.project_id}</Row>
              <Row term={t("access.columns.requester")}>
                <Person name={requesterName} org={requesterOrg} />
              </Row>
              <Row term={t("access.columns.purpose")}>{t(`enums.Purpose.${req.purpose}`)}</Row>
              <Row term={t("access.request.detail")}>
                {/* Plain text only: user input is never rendered as HTML/Markdown (M10 §16). */}
                <span className="block max-w-prose whitespace-pre-wrap break-words">{req.purpose_detail?.trim() ? req.purpose_detail : "—"}</span>
              </Row>
              <Row term={t("access.request.operations")}>
                <span className="flex flex-wrap gap-1.5">
                  {req.operations.map((o) => (
                    <Tag key={o}>{t(`enums.Operation.${o}`)}</Tag>
                  ))}
                </span>
              </Row>
              <Row term={t("access.columns.days")}>
                <span className="num">{t("data.detail.days", { count: req.requested_days })}</span>
              </Row>
            </dl>
          </section>

          <section aria-labelledby="request-history">
            <h2 id="request-history" className="mb-4 text-heading text-fg">
              {t("access.detail.history")}
            </h2>
            <History request={req} />
          </section>

          {isRequester && req.status === "CHANGE_REQUESTED" ? (
            <ResubmitForm request={req} allowedPurposes={policy.data?.allowed_purposes ?? [req.purpose]} maxGrantDays={maxDays} />
          ) : null}
        </div>

        <div className="flex flex-col gap-4">
          {reviewable ? (
            <Panel id="request-review" title={t("access.detail.reviewPanel")}>
              <RailFacts>
                <Fact term={t("access.detail.maxGrant")}>{t("data.detail.days", { count: Math.min(req.requested_days, maxDays) })}</Fact>
                {policy.data ? (
                  <Fact term={t("access.detail.accessLevel")}>
                    <AccessLevelBadge level={policy.data.access_level} />
                  </Fact>
                ) : null}
              </RailFacts>
              <ReviewActions request={req} maxGrantDays={maxDays} />
            </Panel>
          ) : null}

          {req.status === "APPROVED" && isRequester ? (
            <Panel id="request-grant" title={t("access.detail.grantTitle")}>
              {grant ? (
                <RailFacts>
                  <Fact term={t("access.columns.status")}>
                    <GrantStatusBadge status={grant.status} />
                  </Fact>
                  {grant.status === "ACTIVE" ? (
                    <Fact term={t("access.columns.expires")}>
                      <ExpiryText value={grant.expires_at} />
                    </Fact>
                  ) : null}
                </RailFacts>
              ) : null}
              {!grant || grant.status === "ACTIVE" ? (
                <Link href={`/commons/data/${req.dataset_id}`} className={buttonClass("primary", "md", "w-full")}>
                  <Download aria-hidden="true" />
                  {t("data.detail.download")}
                </Link>
              ) : null}
            </Panel>
          ) : null}

          {isRequester && OPEN.includes(req.status) ? (
            <Panel id="request-mine" title={t("access.detail.minePanel")}>
              <p className="mb-3 text-small text-fg-muted">{t(req.status === "CHANGE_REQUESTED" ? "access.detail.mineChanges" : "access.detail.mineWaiting")}</p>
              <WithdrawAction request={req} />
            </Panel>
          ) : null}

          {policy.data ? (
            <Panel id="request-policy" title={t("access.detail.policyPanel")}>
              <RailFacts>
                {!reviewable ? (
                  <Fact term={t("access.detail.accessLevel")}>
                    <AccessLevelBadge level={policy.data.access_level} />
                  </Fact>
                ) : null}
                <Fact term={t("access.detail.policyMax")}>{t("data.detail.days", { count: maxDays })}</Fact>
              </RailFacts>
              <p className="mb-2 text-small text-fg-muted">{t("access.detail.allowedPurposes")}</p>
              <ul className="flex flex-wrap gap-1.5">
                {policy.data.allowed_purposes.map((p) => (
                  <li key={p}>
                    <Tag>{t(`enums.Purpose.${p}`)}</Tag>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </div>
      </div>
    </>
  );
}
