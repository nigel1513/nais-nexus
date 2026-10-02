"use client";
import { buttonClass, DataTable, EmptyState } from "@nais/ui";
import { KeyRound, Send } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useListAccessGrants, useListAccessRequests } from "@/features/governance/api";
import { flattenPages } from "@/shared/api/pagination";
import type { AccessGrant, AccessRequest } from "@/shared/api/types";
import { GrantStatusBadge, RequestStatusBadge } from "@/shared/ui/badges";
import { DateTime, ExpiryText } from "@/shared/ui/date-text";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";

export function ProjectDataTab({ projectId }: { projectId: string }) {
  const t = useTranslations();
  const grants = useListAccessGrants({ role: "subject", project_id: projectId });
  const requests = useListAccessRequests({ role: "requester", project_id: projectId });
  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="project-grants">
        <h2 id="project-grants" className="mb-3 flex items-baseline gap-2 text-heading text-fg">
          {t("projects.data.grants")}
          {grants.isSuccess ? <span className="num text-small font-normal text-fg-muted">{flattenPages(grants.data).length}</span> : null}
        </h2>
        {grants.isPending ? (
          <DelayedSkeleton />
        ) : grants.isError ? (
          <ErrorView error={grants.error} onRetry={() => void grants.refetch()} />
        ) : (
          <DataTable<AccessGrant>
            caption={t("projects.data.grants")}
            rows={flattenPages(grants.data)}
            rowKey={(g) => g.access_grant_id}
            empty={<EmptyState icon={KeyRound} title={t("projects.data.noGrants")} description={t("projects.data.noGrantsHint")} />}
            columns={[
              { key: "dataset", header: t("access.columns.dataset"), cell: (g) => <Link className="font-medium text-fg underline-offset-4 hover:underline" href={`/commons/data/${g.dataset_id}`}>{g.dataset_title ?? g.dataset_id}</Link> },
              { key: "purpose", header: t("access.columns.purpose"), cell: (g) => t(`enums.Purpose.${g.purpose}`) },
              { key: "status", header: t("access.columns.status"), cell: (g) => <GrantStatusBadge status={g.status} /> },
              { key: "expires", header: t("access.columns.expires"), numeric: true, cell: (g) => <ExpiryText value={g.expires_at} /> },
            ]}
          />
        )}
      </section>
      <section aria-labelledby="project-requests">
        <h2 id="project-requests" className="mb-3 flex items-baseline gap-2 text-heading text-fg">
          {t("projects.data.requests")}
          {requests.isSuccess ? <span className="num text-small font-normal text-fg-muted">{flattenPages(requests.data).length}</span> : null}
        </h2>
        {requests.isPending ? (
          <DelayedSkeleton />
        ) : requests.isError ? (
          <ErrorView error={requests.error} onRetry={() => void requests.refetch()} />
        ) : (
          <DataTable<AccessRequest>
            caption={t("projects.data.requests")}
            rows={flattenPages(requests.data)}
            rowKey={(r) => r.access_request_id}
            empty={<EmptyState icon={Send} title={t("projects.data.noRequests")} description={t("projects.data.noRequestsHint")} action={<Link href="/commons/data" className={buttonClass("secondary", "sm")}>{t("projects.data.findData")}</Link>} />}
            columns={[
              { key: "dataset", header: t("access.columns.dataset"), cell: (r) => <Link className="font-medium text-fg underline-offset-4 hover:underline" href={`/commons/access/${r.access_request_id}`}>{r.dataset_title ?? r.dataset_id}</Link> },
              { key: "status", header: t("access.columns.status"), cell: (r) => <RequestStatusBadge status={r.status} /> },
              { key: "updated", header: t("access.columns.updated"), numeric: true, cell: (r) => <DateTime value={r.updated_at} /> },
            ]}
          />
        )}
      </section>
    </div>
  );
}
