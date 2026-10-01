"use client";
import { Check, Copy } from "lucide-react";
import * as React from "react";
import { cn } from "./cn";
import { copyText } from "./copy-text";
import { IconButton } from "./icon-button";
import { iconStroke } from "./styles";
import { Tooltip } from "./tooltip";

/** Where to cut: keep the file name (after the last "/"), or the last 12 characters for IDs and hashes. */
export function splitForMiddleEllipsis(value: string, tailChars = 12): [string, string] {
  const slash = value.lastIndexOf("/");
  const cut = slash > 0 && value.length - slash <= 48 ? slash : Math.max(0, value.length - tailChars);
  return [value.slice(0, cut), value.slice(cut)];
}

/**
 * Monospace path / ID that is shortened in the middle, so both the root and the file name stay visible
 * (spec §4 Code / PathText). The head gives way first (down to a few characters and its ellipsis); only on very
 * narrow screens does the tail truncate too. Head and tail together read as the full value for screen readers; the tooltip shows it
 * whole. The copy button works on plain http (copyText falls back to execCommand).
 */
export function PathText({
  value,
  copyLabel,
  copiedLabel,
  className,
}: {
  value: string;
  /** Accessible name of the copy button; omit to hide it. */
  copyLabel?: string;
  /** Announced after a successful copy. */
  copiedLabel?: string;
  className?: string;
}) {
  const [head, tail] = splitForMiddleEllipsis(value);
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <span className={cn("inline-flex min-w-0 max-w-full items-center gap-1 font-mono text-mono text-fg", className)}>
      <Tooltip content={<span className="break-all font-mono">{value}</span>}>
        {/* Focusable so keyboard users can reach the full value in the tooltip. */}
        <span tabIndex={0} className="flex min-w-0 rounded-[4px] outline-none focus-visible:outline-2 focus-visible:outline-focus">
          <span data-part="head" className="min-w-8 shrink-[1000] truncate">
            {head}
          </span>
          <span data-part="tail" className="min-w-0 truncate whitespace-pre">
            {tail}
          </span>
        </span>
      </Tooltip>
      {copyLabel ? (
        <>
          <IconButton
            label={copyLabel}
            size="sm"
            className="size-6 [&_svg]:size-3.5"
            onClick={async () => setCopied(await copyText(value))}
          >
            {copied ? <Check aria-hidden="true" strokeWidth={2} className="text-success" /> : <Copy aria-hidden="true" strokeWidth={iconStroke} />}
          </IconButton>
          <span aria-live="polite" className="sr-only">
            {copied ? copiedLabel : ""}
          </span>
        </>
      ) : null}
    </span>
  );
}
