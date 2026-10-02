"use client";
import { useTranslations } from "next-intl";
import { UserCombobox } from "@/features/projects/components/user-combobox";
import { RailSection } from "./facet-panel";

/**
 * Person picker for principal_investigator_id. The id lives in the URL; the picked name goes to the caller, which
 * shows it as an active-filter chip (removing the chip clears the filter).
 */
export function PrincipalInvestigatorFilter({ value, onPick }: { value: string; onPick: (id: string, name: string) => void }) {
  const t = useTranslations();
  return (
    // The section title names the field; the picker's own label stays for screen readers only. The picker is shared
    // with forms (min-w-64, a permanent hint line), so the rail narrows it and shows the hint only while typing.
    <RailSection title={t("data.search.pi.label")}>
      <div className="flex flex-col [&>div]:min-w-0 [&_label]:sr-only [&:has(input:placeholder-shown)_p]:hidden">
        {/* Remount after a pick or a clear so the box empties: the chip above the results carries the choice. */}
        <UserCombobox key={value || "none"} value={null} onChange={(u) => u && onPick(u.user_id, u.display_name)} />
      </div>
    </RailSection>
  );
}
