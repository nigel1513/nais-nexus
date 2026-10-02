"use client";
import { Badge, Button, ConfirmDialog, Label, Select } from "@nais/ui";
import { TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { UserPicker } from "@/features/catalog/components/user-picker";
import { useListOrganizations, useTransferUser } from "@/features/organizations/api";
import type { IdentityPublicProfile } from "@/shared/api/types";
import { notify } from "@/shared/ui/toast";
import { ErrorView } from "@/shared/ui/state-views";
import { SettingsSectionCard } from "./settings-layout";

/** PLATFORM_ADMIN only (the caller gates it; the server still decides): move a user to another institute. */
export function TransferCard() {
  const t = useTranslations();
  const selectId = useId();
  const orgs = useListOrganizations();
  const transfer = useTransferUser();
  const [user, setUser] = useState<IdentityPublicProfile | null>(null);
  const [orgId, setOrgId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [pickerKey, setPickerKey] = useState(0);
  const org = (orgs.data?.items ?? []).find((o) => o.organization_id === orgId);
  const name = user?.display_name ?? "";

  const run = () =>
    transfer.mutate(
      { userId: user!.user_id, organizationId: orgId },
      {
        onSuccess: () => {
          setConfirming(false);
          notify.success(t("org.transfer.done", { name, org: org?.name ?? "" }));
          setUser(null);
          setOrgId("");
          setPickerKey((k) => k + 1);
        },
        onError: () => setConfirming(false),
      },
    );

  return (
    <SettingsSectionCard
      id="transfer"
      title={t("org.transfer.title")}
      description={t("org.transfer.description")}
      actions={<Badge tone="warning">{t("org.transfer.platformOnly")}</Badge>}
      footer={
        <>
          <Button className="ml-auto" variant="primary" size="sm" disabled={!user || !orgId || transfer.isPending} onClick={() => setConfirming(true)}>
            {t("org.transfer.submit")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_14rem] md:items-start">
          <UserPicker key={pickerKey} label={t("org.transfer.user")} onChange={setUser} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={selectId}>{t("org.transfer.target")}</Label>
            <Select id={selectId} value={orgId} onChange={(e) => setOrgId(e.target.value)}>
              <option value="">{t("org.transfer.choose")}</option>
              {(orgs.data?.items ?? [])
                .filter((o) => o.organization_id !== user?.organization_id)
                .map((o) => (
                  <option key={o.organization_id} value={o.organization_id}>
                    {o.name}
                  </option>
                ))}
            </Select>
          </div>
        </div>
        <p className="flex items-start gap-2 rounded-sm border border-warning-line bg-warning-soft px-3 py-2 text-small text-fg">
          <TriangleAlert aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0 text-warning" />
          {t("org.transfer.warning")}
        </p>
        {transfer.isError ? <ErrorView error={transfer.error} onRetry={() => setConfirming(true)} /> : null}
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(o) => !o && setConfirming(false)}
        title={t("org.transfer.confirmTitle", { name, org: org?.name ?? "" })}
        description={t("org.transfer.warning")}
        confirmLabel={t("org.transfer.confirm")}
        cancelLabel={t("common.cancel")}
        closeLabel={t("common.close")}
        destructive
        pending={transfer.isPending}
        onConfirm={run}
      />
    </SettingsSectionCard>
  );
}
