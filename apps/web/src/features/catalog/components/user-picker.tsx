"use client";
import { Avatar, IconButton, Label, SearchCombobox, cn } from "@nais/ui";
import { CircleAlert, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
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

type ChipPerson = { name: string; org: string; ntis?: string | null };
/** "Name (Org)" (the stored label) → name and organization. */
const fromLabel = (label: string, ntis?: string | null): ChipPerson => {
  const m = /^(.*) \(([^()]*)\)$/.exec(label);
  return m ? { name: m[1]!, org: m[2]!, ntis } : { name: label, org: "", ntis };
};
const fromProfile = (u: IdentityPublicProfile): ChipPerson => ({ name: u.display_name, org: u.organization_name ?? "—", ntis: u.national_researcher_number });

/**
 * Person search on a Base UI combobox: type ≥2 chars, ArrowUp/Down to move, Enter to pick, Escape to close.
 * `organizationId` narrows the search (people pickers of a dataset are limited to the owner organization).
 * Typing clears the selection (onChange(null)); `initialText` seeds the box with an already chosen person.
 * With `chip`, a chosen person shows as avatar + name + "org · NTIS" with a change button instead of raw text
 * (`initialPerson` seeds it). With `onRevert`, leaving the box without picking puts the current person back instead
 * of silently keeping a person the box no longer shows.
 */
export function UserPicker({
  id,
  label,
  hideLabel,
  organizationId,
  initialText = "",
  initialPerson,
  chip,
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
  /** With `chip`: the already chosen person. */
  initialPerson?: { label: string; ntis?: string | null } | null;
  chip?: boolean;
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
  const labelId = `${inputId}-label`;
  const [text, setText] = useState(chip ? "" : initialText);
  const [picked, setPicked] = useState<IdentityPublicProfile | null>(null);
  const [dirty, setDirty] = useState(false);
  const [person, setPerson] = useState<ChipPerson | null>(chip && initialPerson ? fromLabel(initialPerson.label, initialPerson.ntis) : null);
  const [searching, setSearching] = useState(!person);
  const inputRef = useRef<HTMLDivElement>(null);
  const debounced = useDebouncedValue(text, 250);
  const users = useListUsers(debounced, organizationId);
  const short = debounced.trim().length < 2;
  const options = short || !dirty ? [] : (users.data?.items ?? []);
  // The list's empty row carries hint / loading / no-results; the live region only announces a result count.
  const emptyText = short ? t("projects.members.searchHint") : users.isFetching ? t("common.loading") : t("projects.members.resultCount", { count: 0 });
  const status = options.length ? t("projects.members.resultCount", { count: options.length }) : "";
  const showChip = chip && person && !searching;

  useEffect(() => {
    if (chip && searching && person) inputRef.current?.querySelector("input")?.focus();
    // Only when switching from the chip to the search box.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching]);

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <Label id={labelId} htmlFor={showChip ? undefined : inputId} className={hideLabel ? "sr-only" : undefined}>
        {label}
        {required ? <span className="ml-1 font-normal text-fg-muted">{t("common.required")}</span> : null}
      </Label>
      {showChip ? (
        <div
          id={inputId}
          role="group"
          aria-labelledby={labelId}
          aria-describedby={error ? `${inputId}-error` : undefined}
          tabIndex={-1}
          className={cn(
            "flex h-8 min-w-0 items-center gap-2 rounded-sm border border-border-strong bg-bg-panel pl-2 pr-0.5 outline-none",
            error && "border-danger",
          )}
        >
          <Avatar name={person.name} size={20} decorative />
          <span className="min-w-0 flex-1 truncate" title={[person.name, person.org, person.ntis ? `NTIS ${person.ntis}` : ""].filter(Boolean).join(" · ")}>
            <span className="font-medium text-fg">{person.name}</span>
            <span className="ml-1.5 text-small text-fg-muted">
              {person.org}
              {person.ntis ? (
                <>
                  <span aria-hidden="true"> · </span>
                  <span className="font-mono">NTIS {person.ntis}</span>
                </>
              ) : null}
            </span>
          </span>
          <IconButton
            size="sm"
            label={t("data.form.personChange", { field: label })}
            onClick={() => {
              setSearching(true);
              setText("");
              setDirty(false);
              setPicked(null);
              onChange(null);
            }}
          >
            <X aria-hidden="true" />
          </IconButton>
        </div>
      ) : (
        <div ref={inputRef} className="min-w-0">
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
              if (chip) {
                setPerson(fromProfile(u));
                setSearching(false);
                setText("");
              } else setText(userLabel(u));
            }}
            onBlur={() => {
              if (!onRevert || (!dirty && !(chip && searching && person))) return;
              const restored = onRevert();
              if (restored === null) return;
              setDirty(false);
              if (chip) {
                setSearching(false);
                setText("");
              } else setText(restored);
            }}
            itemToString={userLabel}
            itemKey={(u) => u.user_id}
            renderItem={(u) => <PersonOption user={u} />}
            emptyText={emptyText}
            status={status}
            footer={footer}
            placeholder={t("projects.members.searchPlaceholder")}
            aria-required={required || undefined}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${inputId}-error` : undefined}
          />
        </div>
      )}
      {error ? (
        <p id={`${inputId}-error`} className="flex items-start gap-1.5 text-small text-danger">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
          {error}
        </p>
      ) : null}
    </div>
  );
}
