"use client";
import { Button, Card, CardContent, CardHeader, CardTitle, ConfirmDialog, Label, Select } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { UserPicker } from "@/features/catalog/components/user-picker";
import { useListOrganizations, useTransferUser } from "@/features/organizations/api";
import type { IdentityPublicProfile } from "@/shared/api/types";
import { useToast } from "@/shared/ui/toast";
import { ErrorView } from "@/shared/ui/state-views";

/** PLATFORM_ADMIN only (the caller gates it; the server still decides): move a user to another institute. */
export function TransferCard() {
  const t = useTranslations();
  const toast = useToast();
  const headingId = useId();
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
          toast(t("org.transfer.done", { name, org: org?.name ?? "" }));
          setUser(null);
          setOrgId("");
          setPickerKey((k) => k + 1);
        },
        onError: () => setConfirming(false),
      },
    );

  return (
    <Card aria-labelledby={headingId}>
        <CardHeader>
          <CardTitle id={headingId}>{t("org.transfer.title")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-start gap-3">
            <UserPicker key={pickerKey} label={t("org.transfer.user")} onChange={setUser} />
            <div className="flex min-w-48 flex-col gap-1">
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
          <div>
            <Button size="sm" disabled={!user || !orgId || transfer.isPending} onClick={() => setConfirming(true)}>
              {t("org.transfer.submit")}
            </Button>
          </div>
          {transfer.isError ? <ErrorView error={transfer.error} onRetry={() => setConfirming(true)} /> : null}
        </CardContent>
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
    </Card>
  );
}
