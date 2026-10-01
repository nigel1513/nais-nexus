"use client";
import { CircleAlert, CircleCheck, Info, Loader2, X } from "lucide-react";
import * as React from "react";
import { Toaster as Sonner, toast } from "sonner";
import { cn } from "./cn";
import { iconStroke } from "./styles";

type Kind = "success" | "error" | "info" | "loading";
export type NotifyOptions = { description?: React.ReactNode; id?: string | number; duration?: number };

const labels = { close: "닫기" };

const ICON: Record<Kind, React.ReactNode> = {
  success: <CircleCheck aria-hidden="true" className="size-4 text-success" strokeWidth={iconStroke} />,
  error: <CircleAlert aria-hidden="true" className="size-4 text-danger" strokeWidth={iconStroke} />,
  info: <Info aria-hidden="true" className="size-4 text-fg-muted" strokeWidth={iconStroke} />,
  loading: <Loader2 aria-hidden="true" className="size-4 animate-spin text-fg-muted" strokeWidth={iconStroke} />,
};

/** Our toast markup inside Sonner's headless shell: icon, title, optional description, close. */
export function ToastCard({ kind, title, description, onClose }: { kind: Kind; title: React.ReactNode; description?: React.ReactNode; onClose?: () => void }) {
  return (
    <div
      role={kind === "error" ? "alert" : undefined}
      className="flex w-[var(--width,356px)] max-w-full items-start gap-3 rounded-md border border-border bg-bg-panel p-3 text-fg shadow-popover"
    >
      <span className="mt-0.5 shrink-0">{ICON[kind]}</span>
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium">{title}</p>
        {description ? <p className="mt-0.5 text-small text-fg-muted">{description}</p> : null}
      </div>
      {onClose ? (
        <button
          type="button"
          aria-label={labels.close}
          onClick={onClose}
          className="-m-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-fg-muted outline-none hover:bg-bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-focus"
        >
          <X aria-hidden="true" className="size-3.5" strokeWidth={2} />
        </button>
      ) : null}
    </div>
  );
}

function show(kind: Kind, title: React.ReactNode, opts: NotifyOptions = {}) {
  // Errors stay until dismissed: they carry what the user must act on. Success / info leave after 4s.
  const duration = opts.duration ?? (kind === "error" || kind === "loading" ? Infinity : 4000);
  return toast.custom(
    (id) => <ToastCard kind={kind} title={title} description={opts.description} onClose={kind === "loading" ? undefined : () => toast.dismiss(id)} />,
    { id: opts.id, duration },
  );
}

/** Headless Sonner wrapper so every toast looks the same (spec §4 Toast). Client-side only. */
export const notify = {
  success: (title: React.ReactNode, opts?: NotifyOptions) => show("success", title, opts),
  error: (title: React.ReactNode, opts?: NotifyOptions) => show("error", title, opts),
  info: (title: React.ReactNode, opts?: NotifyOptions) => show("info", title, opts),
  promise<T>(
    promise: Promise<T>,
    msgs: { loading: React.ReactNode; success: React.ReactNode | ((v: T) => React.ReactNode); error: React.ReactNode | ((e: unknown) => React.ReactNode) },
  ): Promise<T> {
    const id = show("loading", msgs.loading);
    promise.then(
      (v) => show("success", typeof msgs.success === "function" ? msgs.success(v) : msgs.success, { id }),
      (e) => show("error", typeof msgs.error === "function" ? msgs.error(e) : msgs.error, { id }),
    );
    return promise;
  },
  dismiss: (id?: string | number) => toast.dismiss(id),
};

/**
 * Mount once at the root. `theme` should be the resolved theme (next-themes `resolvedTheme`); Sonner does not
 * follow the OS on its own. `closeLabel` names every toast's close button.
 */
export function Toaster({ theme, closeLabel, className }: { theme?: "light" | "dark"; closeLabel: string; className?: string }) {
  labels.close = closeLabel;
  return <Sonner position="bottom-right" theme={theme} className={cn("z-60", className)} toastOptions={{ unstyled: true }} gap={8} />;
}
