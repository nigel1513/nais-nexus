"use client";
import {
  Badge,
  Button,
  buttonClass,
  Checkbox,
  ConfirmDialog,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Menu,
  type Tone,
} from "@nais/ui";
import { Ellipsis, UserCheck, UserCog, UserX } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { useUpdateOrganizationMember } from "@/features/organizations/api";
import { asApiError } from "@/shared/api/errors";
import { useErrorText } from "@/shared/api/use-error-text";
import type { ActiveStatus, OrganizationMembership, OrgRole } from "@/shared/api/types";
import { useMeData } from "@/shared/hooks/use-me";
import { notify } from "@/shared/ui/toast";

const ROLES: OrgRole[] = ["ORG_ADMIN", "DATA_STEWARD", "RESOURCE_MANAGER"];
const ROLE_TONE: Record<OrgRole, Tone> = { ORG_ADMIN: "accent", DATA_STEWARD: "info", RESOURCE_MANAGER: "neutral" };
const icon = { "aria-hidden": true, strokeWidth: 1.75 } as const;

/** Organization roles as badges, in a fixed order (admin first). */
export function RoleBadges({ roles }: { roles: OrgRole[] }) {
  const t = useTranslations();
  return (
    <>
      {ROLES.filter((r) => roles.includes(r)).map((r) => (
        <Badge key={r} tone={ROLE_TONE[r]}>
          {t(`enums.OrgRole.${r}`)}
        </Badge>
      ))}
    </>
  );
}

export function MemberStatusBadge({ status }: { status: ActiveStatus }) {
  const t = useTranslations();
  return (
    <Badge dot tone={status === "ACTIVE" ? "success" : "neutral"}>
      {t(`enums.ActiveStatus.${status}`)}
    </Badge>
  );
}

type Step = null | "roles" | "status" | "selfDemotion";

/**
 * Row menu of the members table: 역할 변경 (dialog with the three roles) and 비활성화 / 다시 활성화 (confirm dialog).
 * Same rules as before (M01 §6): an ORG_ADMIN cannot drop their own ORG_ADMIN role, nobody can disable themselves
 * (the server answers 422 either way), a PLATFORM_ADMIN dropping their own ORG_ADMIN role confirms twice.
 */
export function MemberActions({ member, isSelf, organizationId }: { member: OrganizationMembership; isSelf: boolean; organizationId: string }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const update = useUpdateOrganizationMember();
  const me = useMeData();
  const hintId = useId();
  const statusHintId = useId();
  const [step, setStep] = useState<Step>(null);
  const [roles, setRoles] = useState<OrgRole[]>(member.roles);
  const name = member.display_name ?? member.user_id;
  const active = member.status === "ACTIVE";
  const selfLocked = isSelf && member.roles.includes("ORG_ADMIN") && !me.platform_roles.includes("PLATFORM_ADMIN");
  const statusLocked = isSelf; // nobody can disable their own membership (M01 §6), PLATFORM_ADMIN included
  const rolesDirty = [...roles].sort().join() !== [...member.roles].sort().join();
  const selfDemotion = isSelf && member.roles.includes("ORG_ADMIN") && !roles.includes("ORG_ADMIN");

  const save = (patch: { roles?: OrgRole[]; status?: ActiveStatus }) =>
    update.mutate(
      { organizationId, userId: member.user_id, patch },
      {
        onSuccess: () => {
          setStep(null);
          notify.success(t("org.saved"));
        },
        onError: (e) => {
          setStep(null);
          // The server reports the last-ORG_ADMIN rule with the generic ROLE_NOT_ASSIGNABLE code; derive it from what was attempted.
          const dropsAdmin = (patch.roles !== undefined && !patch.roles.includes("ORG_ADMIN")) || patch.status === "DISABLED";
          const lastAdmin = asApiError(e).code === "ROLE_NOT_ASSIGNABLE" && !isSelf && member.roles.includes("ORG_ADMIN") && dropsAdmin;
          notify.error(lastAdmin ? t("org.lastAdminError") : errorText(e));
        },
      },
    );

  const openRoles = () => {
    setRoles(member.roles);
    setStep("roles");
  };

  return (
    <>
      <Menu.Root>
        <Menu.Trigger aria-label={t("org.actionsFor", { name })} className={buttonClass("ghost", "sm", "w-7 px-0")}>
          <Ellipsis {...icon} className="size-4" />
        </Menu.Trigger>
        <Menu.Content align="end" className="max-w-64">
          <Menu.Item icon={<UserCog {...icon} />} onClick={openRoles}>
            {t("org.changeRoles")}
          </Menu.Item>
          <Menu.Separator />
          {active ? (
            <Menu.Item icon={<UserX {...icon} />} tone="danger" disabled={statusLocked} aria-describedby={statusLocked ? statusHintId : undefined} onClick={() => setStep("status")}>
              {t("org.disable")}
            </Menu.Item>
          ) : (
            <Menu.Item icon={<UserCheck {...icon} />} disabled={statusLocked} aria-describedby={statusLocked ? statusHintId : undefined} onClick={() => setStep("status")}>
              {t("org.enable")}
            </Menu.Item>
          )}
          {statusLocked ? <p id={statusHintId} className="px-2 pb-1.5 pt-1 text-caption text-fg-muted">{t(selfLocked ? "org.selfLocked" : "org.selfStatusLocked")}</p> : null}
        </Menu.Content>
      </Menu.Root>

      <Dialog open={step === "roles"} onOpenChange={(o) => !o && setStep(null)}>
        <DialogContent closeLabel={t("common.close")}>
          <DialogTitle>{t("org.rolesTitle", { name })}</DialogTitle>
          <DialogDescription>{member.email ?? t("org.rolesDescription")}</DialogDescription>
          <fieldset className="mt-4">
            <legend className="sr-only">{t("org.rolesFor", { name })}</legend>
            <ul className="divide-y divide-border rounded-md border border-border">
              {ROLES.map((r) => {
                const locked = selfLocked && r === "ORG_ADMIN";
                return (
                  <li key={r} className="px-3 py-2.5">
                    <label className="flex cursor-pointer items-center gap-3 text-body text-fg has-[:disabled]:cursor-not-allowed">
                      <Checkbox
                        checked={roles.includes(r)}
                        disabled={locked}
                        aria-describedby={locked ? hintId : undefined}
                        onChange={(e) => setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))}
                      />
                      <span className="flex-1">{t(`enums.OrgRole.${r}`)}</span>
                    </label>
                    {locked ? (
                      <p id={hintId} className="mt-1 pl-7 text-small text-fg-muted">
                        {t("org.selfLocked")}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </fieldset>
          <DialogFooter>
            <DialogClose render={<Button variant="secondary" />}>{t("common.cancel")}</DialogClose>
            <Button
              variant="primary"
              disabled={!rolesDirty}
              loading={update.isPending}
              onClick={() => (selfDemotion ? setStep("selfDemotion") : save({ roles }))}
            >
              {t("org.saveChanges")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={step === "status"}
        onOpenChange={(o) => !o && setStep(null)}
        title={t(active ? "org.disableTitle" : "org.enableTitle", { name })}
        description={active ? t("org.disableWarning") : t("org.enableDescription")}
        confirmLabel={t(active ? "org.disable" : "org.enable")}
        cancelLabel={t("common.cancel")}
        closeLabel={t("common.close")}
        destructive={active}
        pending={update.isPending}
        onConfirm={() => save({ status: active ? "DISABLED" : "ACTIVE" })}
      />
      <ConfirmDialog
        open={step === "selfDemotion"}
        onOpenChange={(o) => !o && setStep(null)}
        title={t("org.selfDemotionTitle")}
        description={t("org.selfDemotionWarning")}
        confirmLabel={t("org.selfDemotionConfirm")}
        cancelLabel={t("common.cancel")}
        closeLabel={t("common.close")}
        destructive
        pending={update.isPending}
        onConfirm={() => save({ roles })}
      />
    </>
  );
}
