"use client";
import * as React from "react";
import { buttonClass } from "./button";
import { cn } from "./cn";
import { Tooltip } from "./tooltip";

export type IconButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children"> & {
  /** Accessible name, also shown as the tooltip. Required: an icon alone names nothing. */
  label: string;
  children: React.ReactNode;
  variant?: "ghost" | "secondary";
  size?: "sm" | "md";
  /** Set false where the label is already visible next to the button. */
  tooltip?: boolean;
};

/** 28/32px square button holding one 16px icon (spec §4). */
export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, children, variant = "ghost", size = "md", tooltip = true, className, type = "button", ...props },
  ref,
) {
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={buttonClass(variant, size === "sm" ? "sm" : "md", cn(size === "sm" ? "w-7 px-0" : "w-8 px-0", className))}
      {...props}
    >
      {children}
    </button>
  );
  if (!tooltip) return button;
  // A disabled button gets no pointer events, so its tooltip hangs on a wrapping span instead.
  if (props.disabled)
    return (
      <Tooltip content={label}>
        <span className="inline-flex">{button}</span>
      </Tooltip>
    );
  return <Tooltip content={label}>{button}</Tooltip>;
});
