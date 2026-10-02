"use client";
import { Tag } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { UserCombobox } from "@/features/projects/components/user-combobox";
import { RailSection } from "./facet-panel";

/** Person picker for principal_investigator_id; the id lives in the URL, the picked name only in local state. */
export function PrincipalInvestigatorFilter({ value, onChange }: { value: string; onChange: (id: string | null) => void }) {
  const t = useTranslations();
  const [name, setName] = useState<string | null>(null);
  return (
    // The section title names the field; the picker's own label stays for screen readers only. The picker is
    // shared with forms (min-w-64), so the rail narrows it here.
    <RailSection title={t("data.search.pi.label")}>
      <div className="flex flex-col gap-2 [&>div]:min-w-0 [&_label]:sr-only">
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
          <div className="flex">
            <Tag
              removeLabel={t("data.search.pi.clear")}
              onRemove={() => {
                setName(null);
                onChange(null);
              }}
            >
              {name ? t("data.search.pi.selected", { name }) : t("data.search.pi.selectedUnknown")}
            </Tag>
          </div>
        ) : null}
      </div>
    </RailSection>
  );
}
