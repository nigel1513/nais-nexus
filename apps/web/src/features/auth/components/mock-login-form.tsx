"use client";
import { Button, FormField, Select } from "@nais/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { MOCK_USER_COOKIE } from "@/shared/config";

export function MockLoginForm({ callbackUrl, users }: { callbackUrl: string; users: { id: string; label: string; email: string; organization?: string }[] }) {
  const t = useTranslations();
  const router = useRouter();
  const [userId, setUserId] = useState(users[0]?.id ?? "");
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        document.cookie = `${MOCK_USER_COOKIE}=${encodeURIComponent(userId)}; path=/; SameSite=Lax`;
        router.push(callbackUrl);
        router.refresh();
      }}
    >
      <FormField id="mock-user" label={t("auth.mockUser")}>
        {(a11y) => (
          <Select {...a11y} value={userId} onChange={(e) => setUserId(e.target.value)}>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.organization ? `${u.label} · ${u.organization}` : `${u.label} (${u.email})`}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <Button variant="primary" type="submit">{t("auth.signIn")}</Button>
    </form>
  );
}
