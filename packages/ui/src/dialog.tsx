"use client";
import { Dialog as Base } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import * as React from "react";
import { cn } from "./cn";
import { focusRing, iconStroke } from "./styles";

export const Dialog = Base.Root;
export const DialogTrigger = Base.Trigger;
export const DialogClose = Base.Close;

/** Scrim shared by Dialog and Sheet: fades over 150ms. */
export const scrimClass =
  "fixed inset-0 z-50 bg-scrim transition-opacity duration-[var(--dur-fast)] ease-[var(--ease-out)] data-[starting-style]:opacity-0 data-[ending-style]:opacity-0";

export function DialogCloseButton({ label, className }: { label: string; className?: string }) {
  return (
    <Base.Close
      aria-label={label}
      className={cn(
        "press inline-flex size-7 cursor-pointer items-center justify-center rounded-sm text-fg-muted hover:bg-bg-hover hover:text-fg",
        focusRing,
        className,
      )}
    >
      <X aria-hidden="true" className="size-4" strokeWidth={iconStroke} />
    </Base.Close>
  );
}

/**
 * Centered modal (spec §4 Dialog): 480px (`size="sm"`, default) or 640px, radius lg, scales 0.98→1 from the centre
 * in 200ms. Focus is trapped; Esc and the close button return focus to the opener (Base UI default).
 */
export function DialogContent({
  className,
  children,
  closeLabel,
  size = "sm",
  ...props
}: React.ComponentProps<typeof Base.Popup> & { closeLabel: string; size?: "sm" | "md" }) {
  return (
    <Base.Portal>
      <Base.Backdrop className={scrimClass} />
      <Base.Viewport className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <Base.Popup
          className={cn(
            "relative flex max-h-[calc(100dvh-2rem)] w-full flex-col overflow-y-auto rounded-lg border border-border bg-bg-panel p-6 text-fg shadow-dialog outline-none",
            size === "sm" ? "max-w-[480px]" : "max-w-[640px]",
            "transition-[transform,opacity] duration-[var(--dur-base)] ease-[var(--ease-out)]",
            "data-[starting-style]:[transform:scale(0.98)] data-[starting-style]:opacity-0",
            "data-[ending-style]:[transform:scale(0.98)] data-[ending-style]:opacity-0 data-[ending-style]:duration-[var(--dur-fast)]",
            className,
          )}
          {...props}
        >
          {children}
          <DialogCloseButton label={closeLabel} className="absolute right-4 top-4" />
        </Base.Popup>
      </Base.Viewport>
    </Base.Portal>
  );
}

export function DialogTitle({ className, ...props }: React.ComponentProps<typeof Base.Title>) {
  return <Base.Title className={cn("pr-8 text-heading text-fg", className)} {...props} />;
}

export function DialogDescription({ className, ...props }: React.ComponentProps<typeof Base.Description>) {
  return <Base.Description className={cn("mt-1 text-body text-fg-muted", className)} {...props} />;
}

/** Right-aligned actions: cancel (secondary) then confirm (primary / danger). */
export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mt-6 flex flex-wrap justify-end gap-2", className)} {...props} />;
}
