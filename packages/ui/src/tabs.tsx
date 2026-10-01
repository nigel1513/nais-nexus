"use client";
import { Tabs as Base } from "@base-ui/react/tabs";
import * as React from "react";
import { cn } from "./cn";

type RootProps = Omit<React.ComponentProps<typeof Base.Root>, "onValueChange"> & {
  onValueChange?: (value: string) => void;
};

/** Underline tabs (spec §4 Tabs). Switching never animates. */
export function Tabs({ onValueChange, ...props }: RootProps) {
  return <Base.Root onValueChange={onValueChange ? (v) => onValueChange(String(v)) : undefined} {...props} />;
}

export function TabsList({ className, ...props }: React.ComponentProps<typeof Base.List>) {
  return (
    <Base.List
      className={cn("flex gap-6 overflow-x-auto border-b border-border [scrollbar-width:none]", className)}
      {...props}
    />
  );
}

/** 40px tab, 14/500. Active: --fg text with a 2px --fg underline sitting on the list's border. */
export function TabsTrigger({ className, count, children, ...props }: React.ComponentProps<typeof Base.Tab> & { count?: number }) {
  return (
    <Base.Tab
      className={cn(
        "relative flex h-10 shrink-0 cursor-pointer select-none items-center gap-1.5 whitespace-nowrap text-body font-medium text-fg-muted outline-none",
        "hover:text-fg data-[active]:text-fg data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        "after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-t-sm after:bg-transparent data-[active]:after:bg-fg",
        "focus-visible:rounded-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus",
        className,
      )}
      {...props}
    >
      {children}
      {count !== undefined ? <span className="num rounded-sm bg-bg-active px-1.5 text-caption text-fg-muted">{count}</span> : null}
    </Base.Tab>
  );
}

export function TabsContent({ className, ...props }: React.ComponentProps<typeof Base.Panel>) {
  return <Base.Panel className={cn("pt-6 outline-none focus-visible:outline-2 focus-visible:outline-focus", className)} {...props} />;
}
