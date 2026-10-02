"use client";
import { Avatar, Button, IconButton, SelectMenu } from "@nais/ui";
import { CircleAlert, Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ENUMS } from "@/generated/contracts";
import type { IdentityPublicProfile } from "@/shared/api/types";
import { UserPicker, userLabel } from "./user-picker";

export type ContributorValue = { user_id: string; label: string; role: (typeof ENUMS.ContributorRole)[number] };

/** "Name (Org)" → name and organization, for the two-tone row. */
const splitLabel = (label: string) => {
  const m = /^(.*) \(([^()]*)\)$/.exec(label);
  return m ? { name: m[1]!, org: m[2]! } : { name: label, org: "" };
};

/** Contributors as a compact table (name · organization, role, remove) with an add row underneath. */
export function ContributorsEditor({ id, value, onChange, error }: { id?: string; value: ContributorValue[]; onChange: (v: ContributorValue[]) => void; error?: string }) {
  const t = useTranslations();
  const [picked, setPicked] = useState<IdentityPublicProfile | null>(null);
  const [role, setRole] = useState<ContributorValue["role"]>("CO_INVESTIGATOR");
  const [pickerKey, setPickerKey] = useState(0);
  const base = id ?? "contributors";
  const dup = !!picked && value.some((c) => c.user_id === picked.user_id && c.role === role);
  const cols = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 sm:grid-cols-[minmax(0,1fr)_11rem_2rem]";

  return (
    <div id={id} className="flex flex-col gap-1.5" aria-describedby={error ? `${base}-error` : undefined}>
      <div className="overflow-hidden rounded-md border border-border bg-bg-panel">
        <div className={`${cols} hidden h-8 border-b border-border bg-bg-subtle px-3 text-caption text-fg-muted sm:grid`} aria-hidden="true">
          <span>{t("data.form.contributorName")}</span>
          <span>{t("data.form.contributorRole")}</span>
          <span />
        </div>
        {value.length ? (
          <ul aria-label={t("data.form.contributors")}>
            {value.map((c) => {
              const { name, org } = splitLabel(c.label);
              return (
                <li key={`${c.user_id}|${c.role}`} className={`${cols} min-h-10 border-b border-border px-3 py-1.5 last:border-b-0`}>
                  <span className="flex min-w-0 items-center gap-2">
                    <Avatar name={name} size={20} decorative />
                    <span className="min-w-0 truncate">
                      <span className="font-medium">{name}</span>
                      {org ? <span className="ml-1.5 text-small text-fg-muted">{org}</span> : null}
                    </span>
                  </span>
                  <span className="hidden text-small text-fg sm:block">{t(`enums.ContributorRole.${c.role}`)}</span>
                  <IconButton
                    size="sm"
                    variant="ghost"
                    label={t("data.form.contributorRemoveNamed", { name, role: t(`enums.ContributorRole.${c.role}`) })}
                    onClick={() => onChange(value.filter((x) => !(x.user_id === c.user_id && x.role === c.role)))}
                  >
                    <X aria-hidden="true" />
                  </IconButton>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-3 py-3 text-small text-fg-muted">{t("data.form.contributorsEmpty")}</p>
        )}
        <div className="flex flex-col gap-2 border-t border-border bg-bg-subtle p-2 sm:flex-row sm:items-start">
          <UserPicker key={pickerKey} hideLabel label={t("data.form.contributorSearch")} onChange={setPicked} footer={t("data.form.contributorScope")} />
          <SelectMenu
            className="sm:w-44"
            aria-label={t("data.form.contributorRole")}
            value={role}
            onValueChange={(v) => v && setRole(v as ContributorValue["role"])}
            options={ENUMS.ContributorRole.map((r) => ({ value: r, label: t(`enums.ContributorRole.${r}`) }))}
          />
          <Button
            variant="secondary"
            disabled={!picked || dup}
            onClick={() => {
              if (!picked) return;
              onChange([...value, { user_id: picked.user_id, label: userLabel(picked), role }]);
              setPicked(null);
              setPickerKey((k) => k + 1);
            }}
          >
            <Plus aria-hidden="true" />
            {t("data.form.contributorAdd")}
          </Button>
        </div>
      </div>
      <p className="text-small text-fg-muted">{t("data.form.contributorsHint")}</p>
      {error ? (
        <p id={`${base}-error`} className="flex items-start gap-1.5 text-small text-danger">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
          {error}
        </p>
      ) : null}
    </div>
  );
}
