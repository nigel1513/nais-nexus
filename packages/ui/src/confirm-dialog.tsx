"use client";
import * as React from "react";
import { Button } from "./button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./dialog";

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  closeLabel,
  destructive,
  pending,
  confirmDisabled,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  closeLabel: string;
  destructive?: boolean;
  pending?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  children?: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={closeLabel} {...(description ? {} : { "aria-describedby": undefined })}>
        <DialogTitle>{title}</DialogTitle>
        {description ? <DialogDescription>{description}</DialogDescription> : null}
        {children ? <div className="mt-4 flex flex-col gap-3">{children}</div> : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{cancelLabel}</Button>
          </DialogClose>
          <Button variant={destructive ? "destructive" : "default"} disabled={pending || confirmDisabled} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
