"use client";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Button } from "./button";
import { copyText } from "./copy-text";
import { iconStroke } from "./styles";

export function ErrorState({
  title,
  message,
  traceId,
  traceIdLabel,
  copyLabel,
  copiedLabel,
  copyFailedLabel,
  retryLabel,
  onRetry,
}: {
  title: string;
  message: string;
  traceId?: string | null;
  traceIdLabel: string;
  copyLabel: string;
  copiedLabel: string;
  copyFailedLabel: string;
  retryLabel?: string;
  onRetry?: () => void;
}) {
  const [copyState, setCopyState] = useState<"copied" | "failed" | null>(null);
  return (
    <div role="alert" className="flex gap-3 rounded-md border border-border bg-bg-panel p-4">
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" strokeWidth={iconStroke} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-body font-semibold text-fg">{title}</p>
        <p className="text-body text-fg-muted">{message}</p>
        {traceId ? (
          <p className="mt-1 flex flex-wrap items-center gap-2 text-small text-fg-muted">
            <span>
              {traceIdLabel}: <code className="select-all break-all font-mono text-mono text-fg">{traceId}</code>
            </span>
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                // Reset first so a repeated copy re-announces the same message.
                setCopyState(null);
                // Yield so the reset above commits before the result is set; otherwise React batches them
                // and a repeated result is never re-announced.
                const ok = await copyText(traceId);
                await Promise.resolve();
                setCopyState(ok ? "copied" : "failed");
              }}
            >
              {copyLabel}
            </Button>
            <span aria-live="polite">{copyState === "copied" ? copiedLabel : copyState === "failed" ? copyFailedLabel : ""}</span>
          </p>
        ) : null}
        {onRetry && retryLabel ? (
          <div className="mt-2">
            <Button size="sm" variant="primary" onClick={onRetry}>
              {retryLabel}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
