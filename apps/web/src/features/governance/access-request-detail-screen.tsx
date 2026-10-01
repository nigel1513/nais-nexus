"use client";
import { buttonClass } from "@nais/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { useGetDatasetPolicy } from "@/features/catalog/api";
import { useOrgNames } from "@/features/organizations/api";
import { flattenPages } from "@/shared/api/pagination";
import { useMeData } from "@/shared/hooks/use-me";
import { GrantStatusBadge, RequestStatusBadge } from "@/shared/ui/badges";
import { DateTime, ExpiryText } from "@/shared/ui/date-text";
import { PageHeader } from "@/shared/ui/page-header";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { useGetAccessRequest, useListAccessGrants, useStartAccessReview } from "./api";
import { RequesterActions } from "./components/requester-actions";
import { ReviewActions } from "./components/review-actions";

const REVIEWABLE = ["SUBMITTED", "UNDER_REVIEW"];
const SENSITIVE_MAX_DAYS = 30;
const OPEN = ["SUBMITTED", "UNDER_REVIEW", "CHANGE_REQUESTED"];

export function AccessRequestDetailScreen({ accessRequestId }: { accessRequestId: string }) {
  const t = useTranslations();
  const me = useMeData();
  const orgNames = useOrgNames();
  const q = useGetAccessRequest(accessRequestId);
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

  return (
    <>
      <PageHeader title={t("access.detail.title", { dataset: req.dataset_title ?? "" })}>
        <div className="mt-2">
          <RequestStatusBadge status={req.status} />
        </div>
      </PageHeader>
      <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-6">
          <section aria-labelledby="request-summary">
            <h2 id="request-summary" className="mb-2 text-lg font-semibold">
              {t("access.detail.summary")}
            </h2>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[9rem_1fr]">
              <dt className="text-muted-foreground">{t("access.columns.dataset")}</dt>
              <dd>
                <Link href={`/commons/data/${req.dataset_id}`} className="underline-offset-4 hover:underline">
                  {req.dataset_title ?? req.dataset_id}
                </Link>
              </dd>
              <dt className="text-muted-foreground">{t("access.columns.project")}</dt>
              <dd>{req.project_name ?? req.project_id}</dd>
              <dt className="text-muted-foreground">{t("access.columns.requester")}</dt>
              <dd>
                {req.requester_display_name ?? req.requester_user_id} ({orgNames[req.requester_organization_id] ?? "—"})
              </dd>
              <dt className="text-muted-foreground">{t("access.columns.purpose")}</dt>
              <dd>{t(`enums.Purpose.${req.purpose}`)}</dd>
              <dt className="text-muted-foreground">{t("access.request.detail")}</dt>
              {/* Plain text only: user input is never rendered as HTML/Markdown (M10 §16). */}
              <dd className="whitespace-pre-wrap break-words">{req.purpose_detail?.trim() ? req.purpose_detail : "—"}</dd>
              <dt className="text-muted-foreground">{t("access.request.operations")}</dt>
              <dd>{req.operations.map((o) => t(`enums.Operation.${o}`)).join(", ")}</dd>
              <dt className="text-muted-foreground">{t("access.columns.days")}</dt>
              <dd>{t("data.detail.days", { count: req.requested_days })}</dd>
              <dt className="text-muted-foreground">{t("access.detail.createdAt")}</dt>
              <dd>
                <DateTime value={req.created_at} />
              </dd>
            </dl>
          </section>

          {req.status === "APPROVED" && isRequester ? (
            <section aria-labelledby="request-grant" className="rounded-md border border-success p-4">
              <h2 id="request-grant" className="mb-2 font-semibold">
                {t("access.detail.grantTitle")}
              </h2>
              {grant ? (
                <p className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                  <GrantStatusBadge status={grant.status} />
                  {grant.status === "ACTIVE" ? (
                    <span>
                      {t("access.detail.grantExpires")} <ExpiryText value={grant.expires_at} />
                    </span>
                  ) : null}
                </p>
              ) : null}
              {!grant || grant.status === "ACTIVE" ? (
                <Link href={`/commons/data/${req.dataset_id}`} className={buttonClass("primary")}>
                  {t("data.detail.download")}
                </Link>
              ) : null}
            </section>
          ) : null}

          {isReviewer && REVIEWABLE.includes(req.status) ? <ReviewActions request={req} maxGrantDays={maxDays} /> : null}
          {isRequester && OPEN.includes(req.status) ? (
            <RequesterActions request={req} allowedPurposes={policy.data?.allowed_purposes ?? [req.purpose]} maxGrantDays={maxDays} />
          ) : null}
        </div>

        <section aria-labelledby="request-history">
          <h2 id="request-history" className="mb-2 text-lg font-semibold">
            {t("access.detail.history")}
          </h2>
          <ol className="flex flex-col gap-3 border-l-2 border-border pl-4">
            {(req.history ?? []).map((h, i) => (
              <li key={`${h.status}-${h.at}-${i}`} className="flex flex-col gap-1 text-sm">
                <span className="flex flex-wrap items-center gap-2">
                  <RequestStatusBadge status={h.status} />
                  <span className="text-xs text-muted-foreground">
                    <DateTime value={h.at} />
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {h.by_user_id === req.requester_user_id ? t("access.detail.byRequester") : t("access.detail.byReviewer")}
                </span>
                {h.comment ? <p className="whitespace-pre-wrap break-words">{h.comment}</p> : null}
              </li>
            ))}
          </ol>
        </section>
      </div>
    </>
  );
}
