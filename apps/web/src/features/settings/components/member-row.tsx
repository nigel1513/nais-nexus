"use client";
import { Button, Checkbox, ConfirmDialog } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useUpdateOrganizationMember } from "@/features/organizations/api";
import { useErrorText } from "@/shared/api/use-error-text";
import type { ActiveStatus, OrganizationMembership, OrgRole } from "@/shared/api/types";
import { useMeData } from "@/shared/hooks/use-me";
import { useToast } from "@/shared/ui/toast";

const ROLES: OrgRole[] = ["ORG_ADMIN", "DATA_STEWARD", "RESOURCE_MANAGER"];

export function MemberRow({ member, isSelf, organizationId }: { member: OrganizationMembership; isSelf: boolean; organizationId: string }) {
  const t = useTranslations();
  const toast = useToast();
  const errorText = useErrorText();
  const update = useUpdateOrganizationMember();
  const [roles, setRoles] = useState<OrgRole[]>(member.roles);
  const [status, setStatus] = useState<ActiveStatus>(member.status);
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const me = useMeData();
  const name = member.display_name ?? member.user_id;
  const dirty = status !== member.status || [...roles].sort().join() !== [...member.roles].sort().join();
  const disabling = status === "DISABLED" && member.status !== "DISABLED";
  // M01 §6: an ORG_ADMIN cannot drop their own ORG_ADMIN role or disable themselves (the server answers 422); only a PLATFORM_ADMIN can.
  const selfLocked = isSelf && member.roles.includes("ORG_ADMIN") && !me.platform_roles.includes("PLATFORM_ADMIN");
  const hintId = `member-hint-${member.user_id}`;
  const selfDemotion = isSelf && member.roles.includes("ORG_ADMIN") && !roles.includes("ORG_ADMIN");

  const save = () =>
    update.mutate(
      { organizationId, userId: member.user_id, patch: { roles, status } },
      {
        onSuccess: () => {
          setStep(0);
          toast(t("org.saved"));
        },
        onError: (e) => {
          setStep(0);
          toast(errorText(e), "error");
        },
      },
    );

  return (
    <div role="group" aria-label={name} className="flex flex-col gap-2 rounded-md border border-border p-3 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0">
        <p className="font-medium">{name}</p>
        <p className="text-xs text-muted-foreground break-all">{member.email}</p>
      </div>
      <fieldset className="flex flex-wrap gap-3">
        <legend className="sr-only">{t("org.rolesFor", { name })}</legend>
        {ROLES.map((r) => (
          <label key={r} className="flex items-center gap-1 text-sm">
            <Checkbox
              checked={roles.includes(r)}
              disabled={selfLocked && r === "ORG_ADMIN"}
              aria-describedby={selfLocked && r === "ORG_ADMIN" ? hintId : undefined}
              onChange={(e) => setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))} />
            {t(`enums.OrgRole.${r}`)}
          </label>
        ))}
        <label className="flex items-center gap-1 text-sm">
          <Checkbox
            checked={status === "ACTIVE"}
            disabled={selfLocked}
            aria-describedby={selfLocked ? hintId : undefined}
            onChange={(e) => setStatus(e.target.checked ? "ACTIVE" : "DISABLED")} />
          {t("enums.ActiveStatus.ACTIVE")}
        </label>
      </fieldset>
      {selfLocked ? (
        <p id={hintId} className="text-xs text-muted-foreground md:max-w-52">
          {t("org.selfLocked")}
        </p>
      ) : null}
      <Button size="sm" disabled={!dirty || update.isPending} onClick={() => setStep(1)}>
        {t("org.saveChanges")}
      </Button>
      <ConfirmDialog
        open={step === 1}
        onOpenChange={(o) => !o && setStep(0)}
        title={t("org.confirmTitle", { name })}
        description={disabling ? t("org.disableWarning") : t("org.confirmDescription")}
        confirmLabel={t("org.confirm")}
        cancelLabel={t("common.cancel")}
        closeLabel={t("common.close")}
        destructive={disabling}
        pending={update.isPending}
        onConfirm={() => (selfDemotion ? setStep(2) : save())}
      />
      <ConfirmDialog
        open={step === 2}
        onOpenChange={(o) => !o && setStep(0)}
        title={t("org.selfDemotionTitle")}
        description={t("org.selfDemotionWarning")}
        confirmLabel={t("org.selfDemotionConfirm")}
        cancelLabel={t("common.cancel")}
        closeLabel={t("common.close")}
        destructive
        pending={update.isPending}
        onConfirm={save}
      />
    </div>
  );
}
