"use client";
import { Dialog as Base } from "@base-ui/react/dialog";
import * as React from "react";
import { cn } from "./cn";
import { DialogCloseButton, scrimClass } from "./dialog";

export const Sheet = Base.Root;
export const SheetTrigger = Base.Trigger;
export const SheetClose = Base.Close;

/**
 * Edge panel on the Dialog primitive (spec §4 Sheet): right 480px for detail editing, left 280px for mobile
 * navigation. Slides in on --ease-drawer over 280ms and leaves the way it came.
 */
export function SheetContent({
  side = "right",
  closeLabel,
  className,
  children,
  ...props
}: React.ComponentProps<typeof Base.Popup> & { side?: "left" | "right"; closeLabel: string }) {
  return (
    <Base.Portal>
      <Base.Backdrop className={scrimClass} />
      <Base.Popup
        className={cn(
          "fixed inset-y-0 z-50 flex w-full flex-col overflow-y-auto border-border bg-bg-panel text-fg shadow-dialog outline-none",
          "transition-transform duration-[var(--dur-sheet)] ease-[var(--ease-drawer)]",
          side === "right"
            ? "right-0 max-w-[480px] border-l data-[starting-style]:translate-x-full data-[ending-style]:translate-x-full"
            : "left-0 max-w-[280px] border-r data-[starting-style]:-translate-x-full data-[ending-style]:-translate-x-full",
          className,
        )}
        {...props}
      >
        {children}
        <DialogCloseButton label={closeLabel} className="absolute right-3 top-3" />
      </Base.Popup>
    </Base.Portal>
  );
}

export function SheetHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1 border-b border-border px-5 py-4 pr-12", className)} {...props} />;
}

export function SheetTitle({ className, ...props }: React.ComponentProps<typeof Base.Title>) {
  return <Base.Title className={cn("text-heading text-fg", className)} {...props} />;
}

export function SheetDescription({ className, ...props }: React.ComponentProps<typeof Base.Description>) {
  return <Base.Description className={cn("text-small text-fg-muted", className)} {...props} />;
}

export function SheetBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex-1 px-5 py-4", className)} {...props} />;
}
