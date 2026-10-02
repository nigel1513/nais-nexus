"use client";
import { Select as Base } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import * as React from "react";
import { cn } from "./cn";
import { field, floating, iconStroke, listItem } from "./styles";

export type SelectOption = { value: string; label: React.ReactNode; disabled?: boolean };

export type SelectMenuProps = {
  options: SelectOption[];
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (value: string | null) => void;
  placeholder?: React.ReactNode;
  disabled?: boolean;
  id?: string;
  name?: string;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  "aria-required"?: boolean;
};

/**
 * Styled listbox select on Base UI (spec §4 Select). The trigger has the Input's exact size; the list drops below
 * the trigger at least as wide as it, with a check on the chosen option. Arrow keys, typeahead, Enter, Esc.
 * The native-element `Select` in form.tsx stays for react-hook-form `register` fields.
 */
export function SelectMenu({
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder,
  disabled,
  id,
  name,
  className,
  ...aria
}: SelectMenuProps) {
  return (
    <Base.Root
      items={options}
      value={value}
      defaultValue={defaultValue}
      onValueChange={(v) => onValueChange?.(v as string | null)}
      disabled={disabled}
      name={name}
    >
      <Base.Trigger id={id} className={cn(field, "flex cursor-default items-center justify-between gap-2 text-left", className)} {...aria}>
        <Base.Value className="min-w-0 truncate data-[placeholder]:text-fg-subtle" placeholder={placeholder} />
        <Base.Icon className="shrink-0 text-fg-muted">
          <ChevronDown aria-hidden="true" className="size-4" strokeWidth={iconStroke} />
        </Base.Icon>
      </Base.Trigger>
      <Base.Portal>
        <Base.Positioner alignItemWithTrigger={false} sideOffset={4} collisionPadding={8} className="z-[var(--z-popover)]">
          <Base.Popup className={cn(floating, "max-h-[min(var(--available-height),20rem)] min-w-[var(--anchor-width)] overflow-y-auto p-1")}>
            <Base.List>
              {options.map((o) => (
                <Base.Item key={o.value} value={o.value} disabled={o.disabled} className={cn(listItem, "pr-8")}>
                  <Base.ItemText className="min-w-0 flex-1 truncate">{o.label}</Base.ItemText>
                  <Base.ItemIndicator className="absolute right-2 text-fg">
                    <Check aria-hidden="true" strokeWidth={2} />
                  </Base.ItemIndicator>
                </Base.Item>
              ))}
            </Base.List>
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
