"use client";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Command } from "cmdk";
import { Search } from "lucide-react";
import * as React from "react";
import { cn } from "./cn";
import { iconStroke } from "./styles";

function Root({ className, ...props }: React.ComponentProps<typeof Command>) {
  return <Command className={cn("flex w-full flex-col overflow-hidden rounded-md bg-bg-panel text-fg", className)} {...props} />;
}

function Input({ className, ...props }: React.ComponentProps<typeof Command.Input>) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-3">
      <Search aria-hidden="true" className="size-4 shrink-0 text-fg-muted" strokeWidth={iconStroke} />
      <Command.Input
        className={cn("h-11 w-full min-w-0 bg-transparent text-body text-fg outline-none placeholder:text-fg-subtle", className)}
        {...props}
      />
    </div>
  );
}

function List({ className, ...props }: React.ComponentProps<typeof Command.List>) {
  return <Command.List className={cn("max-h-[min(360px,60dvh)] scroll-py-1 overflow-y-auto p-1", className)} {...props} />;
}

function Group({ className, ...props }: React.ComponentProps<typeof Command.Group>) {
  return (
    <Command.Group
      className={cn("[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-caption [&_[cmdk-group-heading]]:text-fg-muted", className)}
      {...props}
    />
  );
}

type ItemProps = React.ComponentProps<typeof Command.Item> & {
  icon?: React.ReactNode;
  /** Keyboard hint on the right, mono (e.g. "G D"). */
  shortcut?: string;
  /** Secondary text on the right, e.g. a dataset's institute. */
  hint?: React.ReactNode;
};

function Item({ className, icon, shortcut, hint, children, ...props }: ItemProps) {
  return (
    <Command.Item
      className={cn(
        "flex h-9 cursor-pointer select-none items-center gap-2 rounded-sm px-2 text-body text-fg outline-none",
        "data-[selected=true]:bg-bg-hover data-[disabled=true]:pointer-events-none data-[disabled=true]:text-fg-subtle",
        "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-muted",
        className,
      )}
      {...props}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint ? <span className="max-w-[40%] shrink-0 truncate text-small text-fg-muted">{hint}</span> : null}
      {shortcut ? <span className="font-mono text-caption text-fg-muted">{shortcut}</span> : null}
    </Command.Item>
  );
}

function Empty({ className, ...props }: React.ComponentProps<typeof Command.Empty>) {
  return <Command.Empty className={cn("px-3 py-6 text-center text-small text-fg-muted", className)} {...props} />;
}

/**
 * ⌘K palette in a modal. Opens and closes with no animation: it is used hundreds of times a day (spec §2.6).
 * `label` names the dialog for screen readers.
 */
function DialogRoot({
  open,
  onOpenChange,
  label,
  children,
  className,
  shouldFilter,
  loop = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  children: React.ReactNode;
  className?: string;
  /** false when the caller filters (e.g. server results that must not be re-filtered by cmdk). */
  shouldFilter?: boolean;
  /** Arrow keys wrap from the last item to the first. */
  loop?: boolean;
}) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-[var(--z-dialog)] bg-scrim" />
        <BaseDialog.Popup
          aria-label={label}
          className={cn(
            "fixed inset-x-0 top-[12dvh] z-[var(--z-dialog)] mx-auto w-[calc(100vw-2rem)] max-w-[640px] overflow-hidden rounded-lg border border-border bg-bg-panel shadow-dialog outline-none",
            className,
          )}
        >
          <Root label={label} shouldFilter={shouldFilter} loop={loop}>
            {children}
          </Root>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

/** cmdk wrapper: `CommandMenu.Root/Input/List/Group/Item/Empty` (no separator: cmdk renders it inside the listbox, which ARIA forbids; groups carry headings), and `CommandMenu.Dialog` for ⌘K. */
export const CommandMenu = { Root, Input, List, Group, Item, Empty, Dialog: DialogRoot };
