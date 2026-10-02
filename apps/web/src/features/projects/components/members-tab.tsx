"use client";
import { Avatar, Badge, Button, ConfirmDialog, DataTable, Label, Select } from "@nais/ui";
import { LogOut, Plus, UserMinus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ENUMS } from "@/generated/contracts";
import { useErrorText } from "@/shared/api/use-error-text";
import type { IdentityPublicProfile, Project, ProjectMember, ProjectRole } from "@/shared/api/types";
import { useMeData } from "@/shared/hooks/use-me";
import { DateTime } from "@/shared/ui/date-text";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { notify } from "@/shared/ui/toast";
import { useAddProjectMember, useListProjectMembers, useRemoveProjectMember, useUpdateProjectMemberRole } from "../api";
import { ProjectRoleBadge } from "./project-role-badge";
import { UserCombobox } from "./user-combobox";

const ROLES = ENUMS.ProjectRole as readonly ProjectRole[];
const ADMIN_MANAGEABLE: readonly ProjectRole[] = ["RESEARCHER", "VIEWER"];

/** Mirrors M02 §5: OWNER manages everyone; ADMIN only RESEARCHER/VIEWER (server stays authoritative). */
export function assignableRoles(actor: ProjectRole | null | undefined): readonly ProjectRole[] {
  return actor === "PROJECT_OWNER" ? ROLES : actor === "PROJECT_ADMIN" ? ADMIN_MANAGEABLE : [];
}
export function canManageMember(actor: ProjectRole | null | undefined, target: ProjectRole): boolean {
  return actor === "PROJECT_OWNER" || (actor === "PROJECT_ADMIN" && ADMIN_MANAGEABLE.includes(target));
}

export function MembersTab({ project, manager }: { project: Project; manager: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const errorText = useErrorText();
  const me = useMeData();
  const pid = project.project_id;
  const members = useListProjectMembers(pid);
  const add = useAddProjectMember(pid);
  const updateRole = useUpdateProjectMemberRole(pid);
  const remove = useRemoveProjectMember(pid);
  const [picked, setPicked] = useState<IdentityPublicProfile | null>(null);
  const [newRole, setNewRole] = useState<ProjectRole>("RESEARCHER");
  const [removing, setRemoving] = useState<ProjectMember | null>(null);
  const [comboKey, setComboKey] = useState(0);
  const fail = (e: unknown) => notify.error(errorText(e));
  const myRole = project.my_role ?? null;
  const addable = assignableRoles(myRole);

  if (members.isPending) return <DelayedSkeleton lines={3} />;
  if (members.isError) return <ErrorView error={members.error} onRetry={() => void members.refetch()} />;
  const removingSelf = removing?.user_id === me.user_id;

  return (
    <div className="flex flex-col gap-4">
      {manager ? (
        <form
          aria-labelledby="invite-title"
          className="flex flex-col gap-3 rounded-md border border-border bg-bg-subtle p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!picked) return;
            add.mutate(
              { user_id: picked.user_id, role: newRole },
              {
                onSuccess: () => {
                  notify.success(t("projects.members.added"));
                  setPicked(null);
                  setComboKey((k) => k + 1);
                },
                onError: fail,
              },
            );
          }}
        >
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="invite-title" className="text-small font-semibold text-fg">
              {t("projects.members.inviteTitle")}
            </h2>
            <span className="text-caption font-normal text-fg-muted">{t("projects.members.inviteHint")}</span>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <UserCombobox key={comboKey} value={picked} onChange={setPicked} />
            <div className="flex flex-col gap-1.5 sm:w-40">
              <Label htmlFor="add-member-role">{t("projects.members.newRole")}</Label>
              <Select id="add-member-role" value={newRole} onChange={(e) => setNewRole(e.target.value as ProjectRole)}>
                {addable.map((r) => (
                  <option key={r} value={r}>
                    {t(`enums.ProjectRole.${r}`)}
                  </option>
                ))}
              </Select>
            </div>
            <Button variant="primary" type="submit" disabled={!picked || add.isPending}>
              <Plus aria-hidden="true" />
              {t("projects.members.add")}
            </Button>
          </div>
        </form>
      ) : null}
      <DataTable<ProjectMember>
        caption={t("projects.members.caption")}
        rows={members.data.items}
        rowKey={(m) => m.user_id}
        columns={[
          {
            key: "name",
            header: t("projects.members.name"),
            cell: (m) => {
              const name = m.display_name ?? m.user_id;
              return (
                <span className="flex min-w-0 items-center gap-2">
                  <Avatar name={name} size={24} decorative />
                  <span className="truncate font-medium text-fg">{name}</span>
                  {m.user_id === me.user_id ? <Badge>{t("projects.members.you")}</Badge> : null}
                </span>
              );
            },
          },
          { key: "org", header: t("projects.members.organization"), cell: (m) => <span className="text-fg-muted">{m.organization_name ?? "—"}</span> },
          {
            key: "role",
            header: t("projects.members.role"),
            className: "w-40",
            cell: (m) =>
              manager && canManageMember(myRole, m.role) ? (
                <Select
                  aria-label={t("projects.members.roleFor", { name: m.display_name ?? m.user_id })}
                  value={m.role}
                  disabled={updateRole.isPending}
                  onChange={(e) =>
                    updateRole.mutate(
                      { userId: m.user_id, role: e.target.value as ProjectRole },
                      { onSuccess: () => notify.success(t("projects.members.roleChanged")), onError: fail },
                    )
                  }
                >
                  {assignableRoles(myRole).map((r) => (
                    <option key={r} value={r}>
                      {t(`enums.ProjectRole.${r}`)}
                    </option>
                  ))}
                </Select>
              ) : (
                <ProjectRoleBadge role={m.role} />
              ),
          },
          { key: "joined", header: t("projects.members.joined"), numeric: true, cell: (m) => <DateTime value={m.joined_at} dateOnly /> },
          {
            key: "actions",
            header: t("common.actions"),
            className: "w-36 text-right",
            cell: (m) =>
              m.user_id === me.user_id ? (
                <Button size="sm" variant="ghost" onClick={() => setRemoving(m)}>
                  <LogOut aria-hidden="true" />
                  {t("projects.members.leave")}
                </Button>
              ) : manager && canManageMember(myRole, m.role) ? (
                <Button size="sm" variant="ghost" onClick={() => setRemoving(m)}>
                  <UserMinus aria-hidden="true" />
                  {t("projects.members.remove")}
                </Button>
              ) : null,
          },
        ]}
      />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={removingSelf ? t("projects.members.leaveTitle") : t("projects.members.removeTitle", { name: removing?.display_name ?? "" })}
        description={t("projects.members.removeWarning")}
        confirmLabel={removingSelf ? t("projects.members.leave") : t("projects.members.remove")}
        cancelLabel={t("common.cancel")}
        closeLabel={t("common.close")}
        destructive
        pending={remove.isPending}
        onConfirm={() => {
          if (!removing) return;
          const self = removingSelf;
          remove.mutate(removing.user_id, {
            onSuccess: () => {
              setRemoving(null);
              if (self) router.push("/commons/projects");
              else notify.success(t("projects.members.removed"));
            },
            onError: (e) => {
              setRemoving(null);
              fail(e);
            },
          });
        }}
      />
    </div>
  );
}
