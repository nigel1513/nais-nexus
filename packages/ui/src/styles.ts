/**
 * Class fragments shared by the primitives. Every value maps to a token in apps/web/src/app/globals.css
 * (spec docs/superpowers/specs/2026-10-01-ui-design-system.md §2, §4).
 */

/** Keyboard focus: 2px --focus outline, 2px offset. Mouse clicks show nothing (:focus-visible). */
export const focusRing = "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/** Text fields: the ring sits inside the border instead of outside (spec §7). */
export const fieldFocus = "outline-none focus-visible:border-focus focus-visible:ring-3 focus-visible:ring-focus-ring";

/** 32px text field shared by Input, the native Select and the SelectMenu / Combobox triggers. */
export const field = [
  "h-8 w-full min-w-0 rounded-sm border border-border-strong bg-bg-panel px-2.5 text-body text-fg",
  "placeholder:text-fg-subtle",
  fieldFocus,
  "aria-[invalid=true]:border-danger aria-[invalid=true]:focus-visible:ring-danger-soft",
  "disabled:cursor-not-allowed disabled:bg-bg-subtle disabled:text-fg-subtle",
  "data-[disabled]:cursor-not-allowed data-[disabled]:bg-bg-subtle data-[disabled]:text-fg-subtle",
].join(" ");

/**
 * Floating surface for Popover, Menu, SelectMenu and Combobox: scales in from its trigger
 * (--transform-origin from Base UI) over 150ms with a strong ease-out, leaves in 100ms.
 */
export const floating = [
  "rounded-md border border-border bg-bg-panel text-fg shadow-popover outline-none",
  "origin-[var(--transform-origin)] transition-[transform,opacity] duration-[var(--dur-fast)] ease-[var(--ease-out)]",
  "data-[starting-style]:[transform:scale(0.97)] data-[starting-style]:opacity-0",
  "data-[ending-style]:opacity-0 data-[ending-style]:duration-[var(--dur-exit)]",
].join(" ");

/** 32px row inside a floating list (menu item, select option, combobox option). */
export const listItem = [
  "relative flex h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 text-body text-fg outline-none",
  "data-[highlighted]:bg-bg-hover",
  "data-[disabled]:pointer-events-none data-[disabled]:text-fg-subtle",
  "[&_svg]:size-4 [&_svg]:shrink-0",
].join(" ");

/** 12px label above a group in a floating list. */
export const listLabel = "px-2 pb-1 pt-2 text-caption text-fg-muted";

export const listSeparator = "-mx-1 my-1 h-px bg-border";

/** Lucide icons: 16px, stroke 1.75 (spec §1). */
export const iconStroke = 1.75;
