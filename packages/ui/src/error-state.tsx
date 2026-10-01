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
  retryLabel,
  onRetry,
}: {
  title: string;
  message: string;
  traceId?: string | null;
  traceIdLabel: string;
  copyLabel: string;
  copiedLabel: string;
  retryLabel?: string;
  onRetry?: () => void;
}) {
  const [copied, setCopied] = useState(false);
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
              await navigator.clipboard?.writeText(traceId);
              setCopied(true);
            }}
          >
            {copyLabel}
          </Button>
          <span aria-live="polite">{copied ? copiedLabel : ""}</span>
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
