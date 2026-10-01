"use client";
import { Switch as Base } from "@base-ui/react/switch";
import * as React from "react";
import { cn } from "./cn";

export type SwitchProps = Omit<React.ComponentProps<typeof Base.Root>, "children" | "className"> & {
  /** Visible label; clicking it toggles too. Omit only when `aria-label` names the switch. */
  label?: React.ReactNode;
  className?: string;
};

/** 28×16 switch; on = --primary track. The thumb slides on transform only. */
export function Switch({ label, className, ...props }: SwitchProps) {
  const control = (
    <Base.Root
      className={cn(
        "relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full bg-border-strong p-0.5 outline-none",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        "data-[checked]:bg-primary data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        !label && className,
      )}
      {...props}
    >
      <Base.Thumb className="block size-3 rounded-full bg-switch-thumb data-[checked]:bg-primary-fg transition-transform duration-[var(--dur-fast)] ease-[var(--ease-out)] data-[checked]:translate-x-3" />
    </Base.Root>
  );
  if (!label) return control;
  return (
    // eslint-disable-next-line jsx-a11y/label-has-associated-control -- the switch is inside the label
    <label className={cn("inline-flex cursor-pointer items-center gap-2 text-body text-fg", className)}>
      {control}
      {label}
    </label>
  );
}
