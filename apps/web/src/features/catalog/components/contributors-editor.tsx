"use client";
import { Button, Label } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ENUMS } from "@/generated/contracts";
import type { IdentityPublicProfile } from "@/shared/api/types";
import { UserPicker, userLabel } from "./user-picker";

export type ContributorValue = { user_id: string; label: string; role: (typeof ENUMS.ContributorRole)[number] };

export function ContributorsEditor({ id, value, onChange, error }: { id?: string; value: ContributorValue[]; onChange: (v: ContributorValue[]) => void; error?: string }) {
  const t = useTranslations();
  const [picked, setPicked] = useState<IdentityPublicProfile | null>(null);
  const [role, setRole] = useState<ContributorValue["role"]>("CO_INVESTIGATOR");
  const [pickerKey, setPickerKey] = useState(0);
  const roleId = `${id ?? "contributors"}-role`;
  const dup = !!picked && value.some((c) => c.user_id === picked.user_id && c.role === role);

  return (
    <div id={id} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-start gap-2">
        <UserPicker key={pickerKey} label={t("data.form.contributorSearch")} onChange={setPicked} />
        <div className="flex flex-col gap-1">
          <Label htmlFor={roleId}>{t("data.form.contributorRole")}</Label>
          <select id={roleId} className="h-10 rounded-md border border-border bg-background px-2" value={role} onChange={(e) => setRole(e.target.value as ContributorValue["role"])}>
            {ENUMS.ContributorRole.map((r) => (
              <option key={r} value={r}>
                {t(`enums.ContributorRole.${r}`)}
              </option>
            ))}
          </select>
        </div>
        <Button
          variant="outline"
          className="mt-6"
          disabled={!picked || dup}
          onClick={() => {
            if (!picked) return;
            onChange([...value, { user_id: picked.user_id, label: userLabel(picked), role }]);
            setPicked(null);
            setPickerKey((k) => k + 1);
          }}
        >
          {t("data.form.contributorAdd")}
        </Button>
      </div>
      {value.length ? (
        <ul className="flex flex-col gap-1 text-sm">
          {value.map((c) => (
            <li key={`${c.user_id}|${c.role}`} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1">
              <span>
                {c.label} <span className="text-muted-foreground">· {t(`enums.ContributorRole.${c.role}`)}</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => onChange(value.filter((x) => !(x.user_id === c.user_id && x.role === c.role)))}>
                {t("data.form.contributorRemove")}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t("data.form.contributorsEmpty")}</p>
      )}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}
