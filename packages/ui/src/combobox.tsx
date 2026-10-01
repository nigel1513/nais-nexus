"use client";
import { Combobox as Base } from "@base-ui/react/combobox";
import { Check, ChevronDown } from "lucide-react";
import * as React from "react";
import { cn } from "./cn";
import { field, floating, iconStroke, listItem } from "./styles";

export type ComboboxProps<T> = {
  items: T[];
  value?: T | null;
  onValueChange?: (value: T | null) => void;
  /** Text shown in the input for an item and used for filtering. */
  itemToString: (item: T) => string;
  /** Stable key for an item (defaults to itemToString). */
  itemKey?: (item: T) => string;
  /** Row content; defaults to the item's string. */
  renderItem?: (item: T) => React.ReactNode;
  placeholder?: string;
  /** Shown when the query matches nothing. */
  emptyText: string;
  /** Accessible name of the open-list button. */
  openLabel: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  "aria-required"?: boolean;
};

/**
 * Text input with a filtered list (spec §4 Combobox). Arrow keys move, Enter picks, Esc closes; on blur without a
 * pick the input returns to the chosen item's text.
 */
export function Combobox<T>({
  items,
  value,
  onValueChange,
  itemToString,
  itemKey,
  renderItem,
  placeholder,
  emptyText,
  openLabel,
  disabled,
  id,
  className,
  ...aria
}: ComboboxProps<T>) {
  const key = itemKey ?? itemToString;
  return (
    <Base.Root
      items={items}
      value={value}
      onValueChange={(v) => onValueChange?.(v as T | null)}
      itemToStringLabel={itemToString}
      isItemEqualToValue={(a, b) => key(a) === key(b)}
      disabled={disabled}
    >
      <div className={cn("relative", className)}>
        <Base.Input id={id} placeholder={placeholder} className={cn(field, "pr-8")} {...aria} />
        <Base.Trigger
          aria-label={openLabel}
          className="absolute inset-y-0 right-0 flex w-8 items-center justify-center rounded-r-sm text-fg-muted outline-none focus-visible:text-fg"
        >
          <ChevronDown aria-hidden="true" className="size-4" strokeWidth={iconStroke} />
        </Base.Trigger>
      </div>
      <Base.Portal>
        <Base.Positioner sideOffset={4} collisionPadding={8} className="z-50">
          <Base.Popup className={cn(floating, "max-h-[min(var(--available-height),20rem)] w-[var(--anchor-width)] overflow-y-auto p-1")}>
            <Base.Empty className="px-2 py-1.5 text-small text-fg-muted empty:hidden">{emptyText}</Base.Empty>
            <Base.List>
              {(item: T) => (
                <Base.Item key={key(item)} value={item} className={cn(listItem, "pr-8")}>
                  <span className="min-w-0 flex-1 truncate">{renderItem ? renderItem(item) : itemToString(item)}</span>
                  <Base.ItemIndicator className="absolute right-2 text-fg">
                    <Check aria-hidden="true" strokeWidth={2} />
                  </Base.ItemIndicator>
                </Base.Item>
              )}
            </Base.List>
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
