"use client";
import { Popover as Base } from "@base-ui/react/popover";
import * as React from "react";
import { cn } from "./cn";
import { floating } from "./styles";

export const Popover = Base.Root;
export const PopoverTrigger = Base.Trigger;
export const PopoverClose = Base.Close;

export type PopoverContentProps = React.ComponentProps<typeof Base.Popup> & {
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  sideOffset?: number;
};

/**
 * Floating panel anchored to its trigger. Layer --z-popover (same as dialogs) so a popover opened from inside a dialog,
 * portalled later in the DOM, paints above it.
 */
export function PopoverContent({ className, side = "bottom", align = "start", sideOffset = 6, ...props }: PopoverContentProps) {
  return (
    <Base.Portal>
      <Base.Positioner side={side} align={align} sideOffset={sideOffset} collisionPadding={8} className="z-[var(--z-popover)]">
        <Base.Popup className={cn(floating, "max-w-[calc(100vw-1rem)] p-4", className)} {...props} />
      </Base.Positioner>
    </Base.Portal>
  );
}

export function PopoverTitle({ className, ...props }: React.ComponentProps<typeof Base.Title>) {
  return <Base.Title className={cn("text-body font-semibold text-fg", className)} {...props} />;
}

export function PopoverDescription({ className, ...props }: React.ComponentProps<typeof Base.Description>) {
  return <Base.Description className={cn("mt-1 text-small text-fg-muted", className)} {...props} />;
}
