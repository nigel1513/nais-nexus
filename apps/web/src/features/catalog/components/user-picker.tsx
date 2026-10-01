"use client";
import { cn, Input, Label } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { useListUsers } from "@/features/organizations/api";
import type { IdentityPublicProfile } from "@/shared/api/types";
import { useDebouncedValue } from "@/shared/hooks/use-debounced-value";

export const userLabel = (u: IdentityPublicProfile) => `${u.display_name} (${u.organization_name ?? "—"})`;

/**
 * ARIA 1.2 combobox: type ≥2 chars, ArrowUp/Down to move, Enter to pick, Escape to close.
 * `organizationId` narrows the search (people pickers of a dataset are limited to the owner organization).
 * Typing clears the selection (onChange(null)); `initialText` seeds the box with an already chosen person.
 */
export function UserPicker({
  id,
  label,
  organizationId,
  initialText = "",
  required,
  error,
  onChange,
}: {
  id?: string;
  label: string;
  organizationId?: string;
  initialText?: string;
  required?: boolean;
  error?: string;
  onChange: (user: IdentityPublicProfile | null) => void;
}) {
  const t = useTranslations();
  const autoId = useId();
  const inputId = id ?? autoId;
  const listId = `${inputId}-list`;
  const [text, setText] = useState(initialText);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const debounced = useDebouncedValue(text, 250);
  const users = useListUsers(debounced, organizationId);
  const options = users.data?.items ?? [];
  const choose = (u: IdentityPublicProfile) => {
    onChange(u);
    setText(userLabel(u));
    setOpen(false);
  };
  const expanded = open && options.length > 0;

  return (
    <div className="relative flex min-w-64 flex-1 flex-col gap-1">
      <Label htmlFor={inputId}>
        {label}
        {required ? <span className="ml-1 text-muted-foreground">{t("common.required")}</span> : null}
      </Label>
      <Input
        id={inputId}
        role="combobox"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${inputId}-error` : undefined}
        aria-activedescendant={expanded ? `${listId}-${active}` : undefined}
        value={text}
        placeholder={t("projects.members.searchPlaceholder")}
        onChange={(e) => {
          setText(e.target.value);
          onChange(null);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, Math.max(options.length - 1, 0)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && expanded && options[active]) {
            e.preventDefault();
            choose(options[active]);
          } else if (e.key === "Escape") setOpen(false);
        }}
      />
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {debounced.trim().length < 2 ? t("projects.members.searchHint") : users.isFetching ? t("common.loading") : t("projects.members.resultCount", { count: options.length })}
      </p>
      {error ? (
        <p id={`${inputId}-error`} className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <ul id={listId} role="listbox" aria-label={label} className={cn("absolute top-16 z-20 w-full rounded-md border border-border bg-background shadow", !expanded && "hidden")}>
        {options.map((u, i) => (
          <li
            key={u.user_id}
            id={`${listId}-${i}`}
            role="option"
            tabIndex={-1}
            aria-selected={i === active}
            className={cn("cursor-pointer px-3 py-2 text-sm", i === active && "bg-muted")}
            onMouseDown={(e) => {
              e.preventDefault();
              choose(u);
            }}
          >
            {userLabel(u)}
          </li>
        ))}
      </ul>
    </div>
  );
}
