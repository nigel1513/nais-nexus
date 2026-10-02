"use client";
import { Tooltip as Base } from "@base-ui/react/tooltip";
import * as React from "react";
import { cn } from "./cn";

/**
 * One provider at the app root: the first tooltip waits 500ms, then neighbours open at once with no animation
 * (Base UI marks those popups `data-instant`) — spec §2.6.
 */
export function TooltipProvider({ children, delay = 500 }: { children: React.ReactNode; delay?: number }) {
  return (
    <Base.Provider delay={delay} closeDelay={0}>
      {children}
    </Base.Provider>
  );
}

export type TooltipProps = {
  /** Tooltip text. Supplementary only: the trigger needs its own accessible name. */
  content: React.ReactNode;
  /** A single focusable element; it becomes the trigger. */
  children: React.ReactElement<Record<string, unknown>>;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  disabled?: boolean;
  className?: string;
};

export function Tooltip({ content, children, side = "top", align = "center", disabled, className }: TooltipProps) {
  return (
    <Base.Root disabled={disabled}>
      <Base.Trigger render={children} />
      <Base.Portal>
        <Base.Positioner side={side} align={align} sideOffset={6} className="z-[var(--z-tooltip)]">
          <Base.Popup
            className={cn(
              "max-w-xs rounded-sm bg-primary px-2 py-1 text-caption text-primary-fg",
              "origin-[var(--transform-origin)] transition-[transform,opacity] duration-[var(--dur-press)] ease-[var(--ease-out)]",
              "data-[starting-style]:[transform:scale(0.97)] data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
              "data-[instant]:transition-none",
              className,
            )}
          >
            {content}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
