"use client";
import { Avatar, Badge, DataTable, EmptyState, type DataColumn } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useGetOrganization, useListOrganizationMembers } from "@/features/organizations/api";
import { flattenPages } from "@/shared/api/pagination";
import type { OrganizationMembership } from "@/shared/api/types";
import { hasOrgRole, useMeData } from "@/shared/hooks/use-me";
import { DateTime } from "@/shared/ui/date-text";
import { PageHeader } from "@/shared/ui/page-header";
import { RequireRole } from "@/shared/ui/require-role";
import { DelayedSkeleton, ErrorView, LoadMore } from "@/shared/ui/state-views";
import { MemberActions, MemberStatusBadge, RoleBadges } from "./components/member-row";
import { SettingsLayout } from "./components/settings-layout";
import { TransferCard } from "./components/transfer-card";

function Members() {
  const t = useTranslations();
  const me = useMeData();
  const orgId = me.organization.organization_id;
  const members = useListOrganizationMembers(orgId);
  const rows = flattenPages(members.data);

  const columns: DataColumn<OrganizationMembership>[] = [
    {
      key: "name",
      header: t("org.columns.member"),
      className: "py-1",
      cell: (m) => {
        const name = m.display_name ?? m.user_id;
        return (
          <span className="flex min-w-0 items-center gap-2">
            <Avatar name={name} size={24} decorative />
            <span className="truncate font-medium text-fg">{name}</span>
            {m.user_id === me.user_id ? <Badge>{t("org.you")}</Badge> : null}
          </span>
        );
      },
    },
    { key: "email", header: t("org.columns.email"), cell: (m) => <span className="break-all text-fg-muted">{m.email ?? "—"}</span> },
    {
      key: "roles",
      header: t("org.columns.roles"),
      cell: (m) =>
        m.roles.length ? (
          <span className="flex flex-wrap gap-1">
            <RoleBadges roles={m.roles} />
          </span>
        ) : (
          <span className="text-fg-muted">{t("org.noRoles")}</span>
        ),
    },
    { key: "status", header: t("org.columns.status"), cell: (m) => <MemberStatusBadge status={m.status} /> },
    { key: "updated", header: t("org.columns.updated"), numeric: true, cell: (m) => (m.updated_at ? <DateTime value={m.updated_at} dateOnly /> : "—") },
    {
      key: "actions",
      header: t("org.columns.actions"),
      className: "w-12 py-1 text-right",
      cell: (m) => <MemberActions key={`${m.user_id}:${m.updated_at ?? ""}`} member={m} isSelf={m.user_id === me.user_id} organizationId={orgId} />,
    },
  ];

  return (
    <section aria-labelledby="org-members" className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <h2 id="org-members" className="text-title text-fg">
          {t("org.members")}
        </h2>
        {members.data ? <span className="num text-small text-fg-muted">{t("org.memberTotal", { count: rows.length })}</span> : null}
      </div>
      {members.isPending ? (
        <DelayedSkeleton lines={5} />
      ) : members.isError ? (
        <ErrorView error={members.error} onRetry={() => void members.refetch()} />
      ) : (
        <>
          <DataTable caption={t("org.memberTable")} columns={columns} rows={rows} rowKey={(m) => m.user_id} empty={<EmptyState title={t("org.noMembers")} />} />
          <LoadMore hasNextPage={members.hasNextPage} isFetchingNextPage={members.isFetchingNextPage} fetchNextPage={members.fetchNextPage} />
        </>
      )}
    </section>
  );
}

export function OrganizationScreen() {
  const t = useTranslations();
  const me = useMeData();
  const orgAdmin = hasOrgRole(me, "ORG_ADMIN");
  const platformAdmin = me.platform_roles.includes("PLATFORM_ADMIN");
  const org = useGetOrganization(orgAdmin || platformAdmin ? me.organization.organization_id : undefined);
  const header = (
    <PageHeader
      title={t("org.title", { name: me.organization.name })}
      description={t("org.description")}
      meta={
        org.data ? (
          <>
            <span>
              {t("org.code")} <span className="font-mono text-mono text-fg">{org.data.code}</span>
            </span>
            <span aria-hidden="true">·</span>
            <span>{t(`enums.OrganizationType.${org.data.type}`)}</span>
            <span aria-hidden="true">·</span>
            <span className="num">{t("org.memberCountValue", { count: org.data.member_count ?? 0 })}</span>
            <span aria-hidden="true">·</span>
            <span className="num">{t("org.datasetCountValue", { count: org.data.dataset_count ?? 0 })}</span>
          </>
        ) : null
      }
    />
  );
  return (
    <SettingsLayout page="organization" header={header}>
      {orgAdmin || !platformAdmin ? (
        <RequireRole anyOf={["ORG_ADMIN"]}>
          <Members />
        </RequireRole>
      ) : null}
      {platformAdmin ? <TransferCard /> : null}
    </SettingsLayout>
  );
}
