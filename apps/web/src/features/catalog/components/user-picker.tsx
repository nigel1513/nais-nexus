"use client";
import { Avatar, Label, SearchCombobox } from "@nais/ui";
import { CircleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState, type ReactNode } from "react";
import { useListUsers } from "@/features/organizations/api";
import type { IdentityPublicProfile } from "@/shared/api/types";
import { useDebouncedValue } from "@/shared/hooks/use-debounced-value";

export const userLabel = (u: IdentityPublicProfile) => `${u.display_name} (${u.organization_name ?? "—"})`;

/** One result row: avatar, name, organization, NTIS number (spec §4 Combobox / UserPicker). */
export function PersonOption({ user }: { user: IdentityPublicProfile }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <Avatar name={user.display_name} size={24} decorative />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{user.display_name}</span>
        <span className="truncate text-caption font-normal text-fg-muted">
          {user.organization_name ?? "—"}
          {user.national_researcher_number ? (
            <>
              <span aria-hidden="true"> · </span>
              <span className="font-mono">NTIS {user.national_researcher_number}</span>
            </>
          ) : null}
        </span>
      </span>
    </span>
  );
}

/**
 * Person search on a Base UI combobox: type ≥2 chars, ArrowUp/Down to move, Enter to pick, Escape to close.
 * `organizationId` narrows the search (people pickers of a dataset are limited to the owner organization).
 * Typing clears the selection (onChange(null)); `initialText` seeds the box with an already chosen person.
 * With `onRevert`, leaving the box without picking puts the current person's label back instead of silently keeping a person the text no longer shows.
 */
export function UserPicker({
  id,
  label,
  hideLabel,
  organizationId,
  initialText = "",
  required,
  error,
  footer,
  onChange,
  onRevert,
}: {
  id?: string;
  label: string;
  /** Keep the label for assistive tech only (e.g. inside a table row). */
  hideLabel?: boolean;
  organizationId?: string;
  initialText?: string;
  required?: boolean;
  error?: string;
  /** Note pinned under the results, e.g. who can be chosen. */
  footer?: ReactNode;
  onChange: (user: IdentityPublicProfile | null) => void;
  /** Edit mode: called on blur when the text was typed over without picking a result. Restores the current person and returns its label (null = nothing to restore). */
  onRevert?: () => string | null;
}) {
  const t = useTranslations();
  const autoId = useId();
  const inputId = id ?? autoId;
  const [text, setText] = useState(initialText);
  const [picked, setPicked] = useState<IdentityPublicProfile | null>(null);
  const [dirty, setDirty] = useState(false);
  const debounced = useDebouncedValue(text, 250);
  const users = useListUsers(debounced, organizationId);
  const short = debounced.trim().length < 2;
  const options = short || !dirty ? [] : (users.data?.items ?? []);
  const status = short ? t("projects.members.searchHint") : users.isFetching ? t("common.loading") : t("projects.members.resultCount", { count: options.length });

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <Label htmlFor={inputId} className={hideLabel ? "sr-only" : undefined}>
        {label}
        {required ? <span className="ml-1 font-normal text-fg-muted">{t("common.required")}</span> : null}
      </Label>
      <SearchCombobox
        id={inputId}
        items={options}
        value={picked}
        inputValue={text}
        onInputChange={(v) => {
          setText(v);
          setDirty(true);
          setPicked(null);
          onChange(null);
        }}
        onPick={(u) => {
          onChange(u);
          setPicked(u);
          setDirty(false);
          setText(userLabel(u));
        }}
        onBlur={() => {
          if (!dirty || !onRevert) return;
          const restored = onRevert();
          if (restored === null) return;
          setText(restored);
          setDirty(false);
        }}
        itemToString={userLabel}
        itemKey={(u) => u.user_id}
        renderItem={(u) => <PersonOption user={u} />}
        emptyText={status}
        status={status}
        footer={footer}
        placeholder={t("projects.members.searchPlaceholder")}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${inputId}-error` : undefined}
      />
      {error ? (
        <p id={`${inputId}-error`} className="flex items-start gap-1.5 text-small text-danger">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
          {error}
        </p>
      ) : null}
    </div>
  );
}
