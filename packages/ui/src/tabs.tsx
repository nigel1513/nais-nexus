"use client";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as React from "react";
import { cn } from "./cn";

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn("flex flex-wrap gap-1 border-b border-border", className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "-mb-px min-h-10 border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground",
        "data-[state=active]:border-primary data-[state=active]:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn("pt-4 focus-visible:outline-2 focus-visible:outline-ring", className)} {...props} />;
}
