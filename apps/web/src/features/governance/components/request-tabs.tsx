"use client";
import { DataTable, EmptyState, type DataColumn } from "@nais/ui";
import { Inbox, Send } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useOrgNames } from "@/features/organizations/api";
import { ENUMS } from "@/generated/contracts";
import { flattenPages } from "@/shared/api/pagination";
import type { AccessRequest, AccessRequestStatus } from "@/shared/api/types";
import { RequestStatusBadge } from "@/shared/ui/badges";
import { DateTime } from "@/shared/ui/date-text";
import { DelayedSkeleton, ErrorView, LoadMore } from "@/shared/ui/state-views";
import { useListAccessRequests } from "../api";
import { ListToolbar, Person, StatusFilter, submittedAt } from "./request-meta";

const href = (r: AccessRequest) => `/commons/access/${r.access_request_id}`;

function RequestTable({
  perspective,
  statuses,
  caption,
  filter,
}: {
  perspective: "requester" | "reviewer";
  statuses: AccessRequestStatus[];
  caption: string;
  filter?: React.ReactNode;
}) {
  const t = useTranslations();
  const router = useRouter();
  const orgNames = useOrgNames();
  const q = useListAccessRequests({ role: perspective, ...(statuses.length ? { status: statuses } : {}) });
  const rows = flattenPages(q.data);

  const dataset: DataColumn<AccessRequest> = {
    key: "dataset",
    header: t("access.columns.dataset"),
    className: "max-w-80",
    cell: (r) => (
      // The row is clickable too; the link keeps a real target for middle-click, screen readers and the phone card list.
      <Link href={href(r)} onClick={(e) => e.stopPropagation()} className="block truncate font-medium text-fg underline-offset-4 hover:underline">
        {r.dataset_title ?? r.dataset_id}
      </Link>
    ),
  };
  const who: DataColumn<AccessRequest> =
    perspective === "reviewer"
      ? {
          key: "requester",
          header: t("access.columns.requester"),
          cell: (r) => <Person name={r.requester_display_name ?? "—"} org={orgNames[r.requester_organization_id]} />,
        }
      : { key: "project", header: t("access.columns.project"), className: "max-w-60", cell: (r) => <span className="block truncate">{r.project_name ?? "—"}</span> };
  const columns: DataColumn<AccessRequest>[] = [
    dataset,
    who,
    { key: "purpose", header: t("access.columns.purpose"), cell: (r) => t(`enums.Purpose.${r.purpose}`) },
    { key: "days", header: t("access.columns.days"), numeric: true, cell: (r) => t("data.detail.days", { count: r.requested_days }) },
    { key: "status", header: t("access.columns.status"), className: "pl-6", cell: (r) => <RequestStatusBadge status={r.status} /> },
    { key: "submitted", header: t("access.columns.submitted"), numeric: true, cell: (r) => <DateTime value={submittedAt(r)} /> },
  ];

  // The toolbar stays mounted while a new filter loads, so the listbox keeps focus.
  return (
    <>
      <ListToolbar count={q.isSuccess ? rows.length : undefined} more={q.hasNextPage} filter={filter} />
      {q.isPending ? (
        <DelayedSkeleton lines={4} />
      ) : q.isError ? (
        <ErrorView error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <DataTable<AccessRequest>
          caption={caption}
          rows={rows}
          rowKey={(r) => r.access_request_id}
          onRowClick={(r) => router.push(href(r))}
          empty={
            perspective === "reviewer" ? (
              <EmptyState className="rounded-md border border-border" icon={Inbox} title={t("access.emptyReview")} description={t("access.emptyReviewHint")} />
            ) : (
              <EmptyState className="rounded-md border border-border" icon={Send} title={t("access.emptyRequests")} description={t("access.emptyRequestsHint")} />
            )
          }
          columns={columns}
        />
      )}
      <LoadMore hasNextPage={q.hasNextPage} isFetchingNextPage={q.isFetchingNextPage} fetchNextPage={q.fetchNextPage} />
    </>
  );
}

export function MyRequestsTab() {
  const t = useTranslations();
  const [status, setStatus] = useState<string>("");
  return (
    <RequestTable
      perspective="requester"
      statuses={status ? [status as AccessRequestStatus] : []}
      caption={t("access.tabs.requests")}
      filter={
        <StatusFilter
          value={status}
          onChange={setStatus}
          options={ENUMS.AccessRequestStatus.filter((s) => s !== "DRAFT").map((s) => ({ value: s, label: t(`enums.AccessRequestStatus.${s}`) }))}
        />
      }
    />
  );
}

export function ReviewTab() {
  const t = useTranslations();
  return <RequestTable perspective="reviewer" statuses={["SUBMITTED", "UNDER_REVIEW"]} caption={t("access.tabs.review")} />;
}
