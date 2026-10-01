"use client";
import { DataTable, EmptyState, Select } from "@nais/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ENUMS } from "@/generated/contracts";
import { flattenPages } from "@/shared/api/pagination";
import type { AccessRequest, AccessRequestStatus } from "@/shared/api/types";
import { RequestStatusBadge } from "@/shared/ui/badges";
import { DateTime } from "@/shared/ui/date-text";
import { DelayedSkeleton, ErrorView, LoadMore } from "@/shared/ui/state-views";
import { useListAccessRequests } from "../api";

function RequestTable({ perspective, statuses, caption }: { perspective: "requester" | "reviewer"; statuses: AccessRequestStatus[]; caption: string }) {
  const t = useTranslations();
  const q = useListAccessRequests({ role: perspective, ...(statuses.length ? { status: statuses } : {}) });
  if (q.isPending) return <DelayedSkeleton lines={4} />;
  if (q.isError) return <ErrorView error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <>
      <DataTable<AccessRequest>
        caption={caption}
        rows={flattenPages(q.data)}
        rowKey={(r) => r.access_request_id}
        empty={<EmptyState title={perspective === "reviewer" ? t("access.emptyReview") : t("access.emptyRequests")} />}
        columns={[
          {
            key: "dataset",
            header: t("access.columns.dataset"),
            cell: (r) => (
              <Link href={`/commons/access/${r.access_request_id}`} className="font-medium underline-offset-4 hover:underline">
                {r.dataset_title ?? r.dataset_id}
              </Link>
            ),
          },
          ...(perspective === "reviewer" ? [{ key: "requester", header: t("access.columns.requester"), cell: (r: AccessRequest) => r.requester_display_name ?? "—" }] : []),
          { key: "project", header: t("access.columns.project"), cell: (r) => r.project_name ?? "—" },
          { key: "purpose", header: t("access.columns.purpose"), cell: (r) => t(`enums.Purpose.${r.purpose}`) },
          { key: "days", header: t("access.columns.days"), cell: (r) => t("data.detail.days", { count: r.requested_days }) },
          { key: "status", header: t("access.columns.status"), cell: (r) => <RequestStatusBadge status={r.status} /> },
          { key: "updated", header: t("access.columns.updated"), cell: (r) => <DateTime value={r.updated_at} /> },
        ]}
      />
      <LoadMore hasNextPage={q.hasNextPage} isFetchingNextPage={q.isFetchingNextPage} fetchNextPage={q.fetchNextPage} />
    </>
  );
}

export function MyRequestsTab() {
  const t = useTranslations();
  const [status, setStatus] = useState<string>("");
  return (
    <div className="flex flex-col gap-3">
      <div className="w-60">
        <label htmlFor="request-status" className="sr-only">
          {t("access.columns.status")}
        </label>
        <Select id="request-status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t("access.allStatuses")}</option>
          {ENUMS.AccessRequestStatus.filter((s) => s !== "DRAFT").map((s) => (
            <option key={s} value={s}>
              {t(`enums.AccessRequestStatus.${s}`)}
            </option>
          ))}
        </Select>
      </div>
      <RequestTable perspective="requester" statuses={status ? [status as AccessRequestStatus] : []} caption={t("access.tabs.requests")} />
    </div>
  );
}

export function ReviewTab() {
  const t = useTranslations();
  return <RequestTable perspective="reviewer" statuses={["SUBMITTED", "UNDER_REVIEW"]} caption={t("access.tabs.review")} />;
}
