"use client";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";
import { cn } from "./cn";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

/**
 * Controlled dialogs have no DialogTrigger, so Radix has nothing to return focus to. This renders only while the content
 * is mounted and remembers the opener in a layout effect, which runs before Radix moves focus inside (its focus effect is
 * a passive effect). The capture is guarded, so StrictMode's simulated unmount/remount neither re-captures nor refocuses.
 */
function FocusReturn({ target }: { target: React.MutableRefObject<HTMLElement | null> }) {
  React.useLayoutEffect(() => {
    if (target.current === null) target.current = document.activeElement as HTMLElement | null;
  }, [target]);
  return null;
}

export function DialogContent({
  className,
  children,
  closeLabel,
  onCloseAutoFocus,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { closeLabel: string }) {
  const returnTo = React.useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/50" />
      <DialogPrimitive.Content
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          const opener = returnTo.current;
          // Forget the opener so the next open (possibly from a different button) captures afresh.
          returnTo.current = null;
          if (event.defaultPrevented) return;
          event.preventDefault();
          if (opener?.isConnected) opener.focus();
        }}
        className={cn(
          "fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-background p-6 shadow-lg",
          className,
        )}
        {...props}
      >
        <FocusReturn target={returnTo} />
        {children}
        <DialogPrimitive.Close
          className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          aria-label={closeLabel}
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogTitle({ className, ...props }: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn("pr-8 text-lg font-semibold", className)} {...props} />;
}

export function DialogDescription({ className, ...props }: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn("mt-2 text-sm text-muted-foreground", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mt-6 flex flex-wrap justify-end gap-2", className)} {...props} />;
}
