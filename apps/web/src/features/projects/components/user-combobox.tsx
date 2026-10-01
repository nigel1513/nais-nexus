"use client";
import { useTranslations } from "next-intl";
import { UserPicker } from "@/features/catalog/components/user-picker";
import type { IdentityPublicProfile } from "@/shared/api/types";

/** Project member search: the generic picker with the project label. */
export function UserCombobox({ onChange }: { value: IdentityPublicProfile | null; onChange: (user: IdentityPublicProfile | null) => void }) {
  const t = useTranslations();
  return <UserPicker label={t("projects.members.searchUser")} onChange={onChange} />;
}
