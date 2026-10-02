"use client";
import { Menu as Base } from "@base-ui/react/menu";
import * as React from "react";
import { cn } from "./cn";
import { floating, listItem, listLabel, listSeparator } from "./styles";

type ContentProps = React.ComponentProps<typeof Base.Popup> & {
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  sideOffset?: number;
};

function Content({ className, side = "bottom", align = "start", sideOffset = 6, ...props }: ContentProps) {
  return (
    <Base.Portal>
      <Base.Positioner side={side} align={align} sideOffset={sideOffset} collisionPadding={8} className="z-[var(--z-popover)]">
        <Base.Popup className={cn(floating, "min-w-48 p-1", className)} {...props} />
      </Base.Positioner>
    </Base.Portal>
  );
}

type ItemProps = React.ComponentProps<typeof Base.Item> & {
  icon?: React.ReactNode;
  /** Keyboard hint shown on the right, e.g. "⌘K". */
  shortcut?: string;
  tone?: "default" | "danger";
};

function Item({ className, icon, shortcut, tone = "default", children, ...props }: ItemProps) {
  return (
    <Base.Item
      className={cn(listItem, tone === "danger" ? "text-danger [&_svg]:text-danger" : "[&_svg]:text-fg-muted", className)}
      {...props}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut ? <span className="ml-4 font-mono text-caption text-fg-muted">{shortcut}</span> : null}
    </Base.Item>
  );
}

type LinkItemProps = React.ComponentProps<typeof Base.LinkItem> & { icon?: React.ReactNode };

function LinkItem({ className, icon, children, ...props }: LinkItemProps) {
  return (
    <Base.LinkItem className={cn(listItem, "[&_svg]:text-fg-muted", className)} {...props}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </Base.LinkItem>
  );
}

function Separator({ className, ...props }: React.ComponentProps<typeof Base.Separator>) {
  return <Base.Separator className={cn(listSeparator, className)} {...props} />;
}

function Label({ className, ...props }: React.ComponentProps<typeof Base.GroupLabel>) {
  return <Base.GroupLabel className={cn(listLabel, className)} {...props} />;
}

/** Dropdown menu (spec §4): `Menu.Root/Trigger/Content/Item/LinkItem/Separator/Group/Label`. Esc returns focus to the trigger. */
export const Menu = {
  Root: Base.Root,
  Trigger: Base.Trigger,
  Content,
  Item,
  LinkItem,
  Separator,
  Group: Base.Group,
  Label,
};

export const DropdownMenu = Menu;
