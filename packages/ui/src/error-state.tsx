"use client";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Button } from "./button";

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
    <div role="alert" className="flex flex-col gap-2 rounded-lg border border-danger p-4">
      <p className="flex items-center gap-2 font-medium text-danger">
        <TriangleAlert aria-hidden="true" className="h-4 w-4" />
        {title}
      </p>
      <p className="text-sm">{message}</p>
      {traceId ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            {traceIdLabel}: <code>{traceId}</code>
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              // Reset first so a repeated copy re-announces the same message.
              setCopyState(null);
              try {
                if (!navigator.clipboard) throw new Error("clipboard unavailable");
                await navigator.clipboard.writeText(traceId);
                setCopyState("copied");
              } catch {
                // Yield so the reset above commits before the failure is set; otherwise React batches them
                // and a repeated failure is never re-announced.
                await Promise.resolve();
                setCopyState("failed");
              }
            }}
          >
            {copyLabel}
          </Button>
          <span aria-live="polite">{copyState === "copied" ? copiedLabel : copyState === "failed" ? copyFailedLabel : ""}</span>
        </p>
      ) : null}
      {onRetry && retryLabel ? (
        <div>
          <Button size="sm" onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
