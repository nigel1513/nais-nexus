"use client";
import { Button, ConfirmDialog, DataTable, FormField, Select } from "@nais/ui";
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
          className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3"
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
          <UserCombobox key={comboKey} value={picked} onChange={setPicked} />
          <FormField id="add-member-role" label={t("projects.members.newRole")}>
            {(a11y) => (
              <Select {...a11y} value={newRole} onChange={(e) => setNewRole(e.target.value as ProjectRole)}>
                {addable.map((r) => (
                  <option key={r} value={r}>
                    {t(`enums.ProjectRole.${r}`)}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <Button variant="primary" type="submit" disabled={!picked || add.isPending}>
            {t("projects.members.add")}
          </Button>
        </form>
      ) : null}
      <DataTable<ProjectMember>
        caption={t("projects.members.caption")}
        rows={members.data.items}
        rowKey={(m) => m.user_id}
        columns={[
          { key: "name", header: t("projects.members.name"), cell: (m) => m.display_name ?? m.user_id },
          { key: "org", header: t("projects.members.organization"), cell: (m) => m.organization_name ?? "—" },
          {
            key: "role",
            header: t("projects.members.role"),
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
                t(`enums.ProjectRole.${m.role}`)
              ),
          },
          { key: "joined", header: t("projects.members.joined"), cell: (m) => <DateTime value={m.joined_at} dateOnly /> },
          {
            key: "actions",
            header: t("common.actions"),
            cell: (m) =>
              m.user_id === me.user_id ? (
                <Button size="sm" variant="outline" onClick={() => setRemoving(m)}>
                  {t("projects.members.leave")}
                </Button>
              ) : manager && canManageMember(myRole, m.role) ? (
                <Button size="sm" variant="outline" onClick={() => setRemoving(m)}>
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
