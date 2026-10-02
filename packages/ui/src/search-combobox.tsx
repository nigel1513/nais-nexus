"use client";
import { Combobox as Base } from "@base-ui/react/combobox";
import { Check } from "lucide-react";
import * as React from "react";
import { cn } from "./cn";
import { field, floating } from "./styles";

export type SearchComboboxProps<T> = {
  /** Results of the current query; the caller filters (usually on the server). */
  items: T[];
  /** The picked item, or null. */
  value: T | null;
  /** Called with the item the user picks. */
  onPick: (item: T) => void;
  /** Text in the input. Controlled: only typing reaches `onInputChange`; picking or closing never rewrites it behind the caller's back. */
  inputValue: string;
  onInputChange: (text: string) => void;
  itemToString: (item: T) => string;
  itemKey: (item: T) => string;
  /** Row content (two-line rows are fine: rows grow to fit). */
  renderItem?: (item: T) => React.ReactNode;
  /** Shown in the list when there are no items (hint, loading or "no results"). */
  emptyText: React.ReactNode;
  /** Pinned under the list, e.g. who can be chosen. */
  footer?: React.ReactNode;
  /** Announced politely (result count, loading). */
  status?: React.ReactNode;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  "aria-required"?: boolean;
};

const row = [
  "relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 pr-8 text-body text-fg outline-none",
  "data-[highlighted]:bg-bg-hover [&_svg]:size-4 [&_svg]:shrink-0",
].join(" ");

/**
 * Combobox over server-side results (spec §4 Combobox / UserPicker): the caller owns the query text and the item list,
 * so typing, debouncing and fetching stay outside. Arrow keys move, Enter picks, Esc closes. Blur behaviour (restore or
 * keep the typed text) is the caller's decision via `onBlur`. Enter with nothing highlighted picks the first result.
 */
export function SearchCombobox<T>({
  items,
  value,
  onPick,
  inputValue,
  onInputChange,
  itemToString,
  itemKey,
  renderItem,
  emptyText,
  footer,
  status,
  placeholder,
  disabled,
  id,
  className,
  onBlur,
  ...aria
}: SearchComboboxProps<T>) {
  const [open, setOpen] = React.useState(false);
  const highlighted = React.useRef<T | null>(null);
  return (
    <Base.Root
      items={items}
      filter={null}
      autoHighlight
      open={open}
      onOpenChange={setOpen}
      onItemHighlighted={(item) => {
        highlighted.current = (item as T | undefined) ?? null;
      }}
      value={value}
      onValueChange={(v) => {
        if (v != null) onPick(v as T);
      }}
      inputValue={inputValue}
      onInputValueChange={(text, details) => {
        if (details.reason === "input-change") onInputChange(text);
      }}
      itemToStringLabel={itemToString}
      isItemEqualToValue={(a, b) => itemKey(a as T) === itemKey(b as T)}
      disabled={disabled}
    >
      <Base.Input
        id={id}
        placeholder={placeholder}
        autoComplete="off"
        className={cn(field, className)}
        onBlur={onBlur}
        onKeyDown={(e) => {
          // Results arrive after typing, so nothing may be highlighted yet: Enter then takes the first result.
          if (e.key === "Enter" && open && !highlighted.current && items[0] !== undefined) {
            e.preventDefault();
            onPick(items[0]);
            setOpen(false);
          }
        }}
        {...aria}
      />
      {/* A plain polite region (not role=status) so screens keep a single status landmark of their own. */}
      <span className="sr-only" aria-live="polite">
        {status}
      </span>
      <Base.Portal>
        <Base.Positioner sideOffset={4} collisionPadding={8} className="z-[var(--z-popover)]">
          <Base.Popup className={cn(floating, "flex max-h-[min(var(--available-height),22rem)] w-[max(var(--anchor-width),18rem)] flex-col overflow-hidden")}>
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              <Base.Empty className="px-2 py-1.5 text-small text-fg-muted empty:hidden">{emptyText}</Base.Empty>
              <Base.List>
                {(item: T) => (
                  <Base.Item key={itemKey(item)} value={item} className={row}>
                    <span className="min-w-0 flex-1">{renderItem ? renderItem(item) : itemToString(item)}</span>
                    <Base.ItemIndicator className="absolute right-2 text-fg">
                      <Check aria-hidden="true" strokeWidth={2} />
                    </Base.ItemIndicator>
                  </Base.Item>
                )}
              </Base.List>
            </div>
            {footer ? <div className="border-t border-border px-3 py-2 text-caption font-normal text-fg-muted">{footer}</div> : null}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
