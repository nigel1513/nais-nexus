"use client";
import { Button, buttonClass, DataTable, EmptyState, Select } from "@nais/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ENUMS } from "@/generated/contracts";
import { useListProjects } from "@/features/projects/api";
import { flattenPages } from "@/shared/api/pagination";
import { useErrorText } from "@/shared/api/use-error-text";
import type { AccessGrant, AccessGrantStatus } from "@/shared/api/types";
import { GrantStatusBadge } from "@/shared/ui/badges";
import { DateTime, ExpiryText } from "@/shared/ui/date-text";
import { DelayedSkeleton, ErrorView, LoadMore } from "@/shared/ui/state-views";
import { notify } from "@/shared/ui/toast";
import { useListAccessGrants, useRevokeAccessGrant } from "../api";
import { ReasonDialog, useServerFieldError } from "./reason-dialog";

const short = (id: string) => id.slice(-8);

export function MyGrantsTab() {
  const t = useTranslations();
  const [status, setStatus] = useState("");
  const q = useListAccessGrants({ role: "subject", ...(status ? { status: [status as AccessGrantStatus] } : {}) });
  const projects = useListProjects({ scope: "mine", limit: 100 });
  const names = Object.fromEntries(flattenPages(projects.data).map((p) => [p.project_id, p.name]));
  return (
    <div className="flex flex-col gap-3">
      <div className="w-60">
        <label htmlFor="grant-status" className="sr-only">
          {t("access.columns.status")}
        </label>
        <Select id="grant-status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t("access.allStatuses")}</option>
          {ENUMS.AccessGrantStatus.map((s) => (
            <option key={s} value={s}>
              {t(`enums.AccessGrantStatus.${s}`)}
            </option>
          ))}
        </Select>
      </div>
      {q.isPending ? (
        <DelayedSkeleton lines={4} />
      ) : q.isError ? (
        <ErrorView error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <DataTable<AccessGrant>
          caption={t("access.tabs.grants")}
          rows={flattenPages(q.data)}
          rowKey={(g) => g.access_grant_id}
          empty={<EmptyState title={t("access.emptyGrants")} />}
          columns={[
            { key: "dataset", header: t("access.columns.dataset"), cell: (g) => g.dataset_title ?? g.dataset_id },
            { key: "project", header: t("access.columns.project"), cell: (g) => names[g.project_id] ?? short(g.project_id) },
            { key: "purpose", header: t("access.columns.purpose"), cell: (g) => t(`enums.Purpose.${g.purpose}`) },
            { key: "status", header: t("access.columns.status"), cell: (g) => <GrantStatusBadge status={g.status} /> },
            { key: "expires", header: t("access.columns.expires"), cell: (g) => (g.status === "ACTIVE" ? <ExpiryText value={g.expires_at} /> : <DateTime value={g.expires_at} />) },
            {
              key: "actions",
              header: t("common.actions"),
              cell: (g) =>
                g.status === "ACTIVE" ? (
                  <Link href={`/commons/data/${g.dataset_id}`} className={buttonClass("outline", "sm")}>
                    {t("data.detail.download")}
                  </Link>
                ) : null,
            },
          ]}
        />
      )}
      <LoadMore hasNextPage={q.hasNextPage} isFetchingNextPage={q.isFetchingNextPage} fetchNextPage={q.fetchNextPage} />
    </div>
  );
}

export function OrgGrantsTab() {
  const t = useTranslations();
  const errorText = useErrorText();
  const fieldError = useServerFieldError();
  const q = useListAccessGrants({ role: "owner", status: ["ACTIVE"] });
  const revoke = useRevokeAccessGrant();
  const [target, setTarget] = useState<AccessGrant | null>(null);
  const [reasonError, setReasonError] = useState<string | undefined>();
  // The dialog keeps showing the last dataset while it animates closed.
  const [lastTitle, setLastTitle] = useState("");
  const close = () => {
    setTarget(null);
    setReasonError(undefined);
  };
  if (q.isPending) return <DelayedSkeleton lines={4} />;
  if (q.isError) return <ErrorView error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <>
      <DataTable<AccessGrant>
        caption={t("access.tabs.orgGrants")}
        rows={flattenPages(q.data)}
        rowKey={(g) => g.access_grant_id}
        empty={<EmptyState title={t("access.emptyOrgGrants")} />}
        columns={[
          { key: "dataset", header: t("access.columns.dataset"), cell: (g) => g.dataset_title ?? g.dataset_id },
          { key: "subject", header: t("access.columns.subject"), cell: (g) => g.subject_display_name ?? <code>{short(g.subject_user_id)}</code> },
          { key: "project", header: t("access.columns.project"), cell: (g) => g.project_name ?? <code>{short(g.project_id)}</code> },
          { key: "purpose", header: t("access.columns.purpose"), cell: (g) => t(`enums.Purpose.${g.purpose}`) },
          { key: "expires", header: t("access.columns.expires"), cell: (g) => <ExpiryText value={g.expires_at} /> },
          {
            key: "actions",
            header: t("common.actions"),
            cell: (g) => (
              <Button size="sm" variant="destructive" onClick={() => {
                  setReasonError(undefined);
                  setLastTitle(g.dataset_title ?? "");
                  setTarget(g);
                }}>
                {t("access.revoke")}
              </Button>
            ),
          },
        ]}
      />
      <LoadMore hasNextPage={q.hasNextPage} isFetchingNextPage={q.isFetchingNextPage} fetchNextPage={q.fetchNextPage} />
      <ReasonDialog
        open={!!target}
        onOpenChange={(o) => !o && close()}
        title={t("access.revokeTitle", { dataset: lastTitle })}
        description={t("access.revokeWarning")}
        label={t("access.revokeReason")}
        confirmLabel={t("access.revoke")}
        destructive
        pending={revoke.isPending}
        error={reasonError}
        onConfirm={(reason) =>
          target &&
          revoke.mutate(
            { grantId: target.access_grant_id, reason },
            {
              onSuccess: () => {
                close();
                notify.success(t("access.revoked"));
              },
              onError: (e) => {
                const field = fieldError(e, "reason");
                if (field) return setReasonError(field);
                close();
                notify.error(errorText(e));
              },
            },
          )
        }
      />
    </>
  );
}
