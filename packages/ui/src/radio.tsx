"use client";
import { Radio as Base } from "@base-ui/react/radio";
import { RadioGroup as BaseGroup } from "@base-ui/react/radio-group";
import * as React from "react";
import { cn } from "./cn";

export type RadioGroupProps = {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  name?: string;
  orientation?: "vertical" | "horizontal";
  className?: string;
  children: React.ReactNode;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
};

/** Arrow keys move the choice within the group (roving focus). */
export function RadioGroup({ onValueChange, orientation = "vertical", className, children, ...props }: RadioGroupProps) {
  return (
    <BaseGroup
      onValueChange={(v) => onValueChange?.(v as string)}
      className={cn("flex", orientation === "vertical" ? "flex-col gap-2" : "flex-row flex-wrap gap-4", className)}
      {...props}
    >
      {children}
    </BaseGroup>
  );
}

/** 16px radio; chosen = --primary face with a dot. The label is part of the click target. */
export function Radio({ value, label, disabled, className }: { value: string; label: React.ReactNode; disabled?: boolean; className?: string }) {
  return (
    // eslint-disable-next-line jsx-a11y/label-has-associated-control -- the radio is inside the label
    <label className={cn("inline-flex cursor-pointer items-center gap-2 text-body text-fg has-[[data-disabled]]:cursor-not-allowed has-[[data-disabled]]:text-fg-subtle", className)}>
      <Base.Root
        value={value}
        disabled={disabled}
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-full border border-border-strong bg-bg-panel outline-none",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
          "data-[checked]:border-primary data-[checked]:bg-primary data-[disabled]:opacity-50",
        )}
      >
        <Base.Indicator className="size-1.5 rounded-full bg-primary-fg" />
      </Base.Root>
      {label}
    </label>
  );
}
