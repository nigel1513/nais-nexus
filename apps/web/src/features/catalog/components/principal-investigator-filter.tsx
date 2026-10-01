"use client";
import { Button } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { UserCombobox } from "@/features/projects/components/user-combobox";

/** Person picker for principal_investigator_id; the id lives in the URL, the picked name only in local state. */
export function PrincipalInvestigatorFilter({ value, onChange }: { value: string; onChange: (id: string | null) => void }) {
  const t = useTranslations();
  const [name, setName] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-semibold">{t("data.search.pi.label")}</span>
      <UserCombobox
        value={null}
        onChange={(u) => {
          if (u) {
            setName(u.display_name);
            onChange(u.user_id);
          }
        }}
      />
      {value ? (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span>{name ? t("data.search.pi.selected", { name }) : t("data.search.pi.selectedUnknown")}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setName(null);
              onChange(null);
            }}
          >
            {t("data.search.pi.clear")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
