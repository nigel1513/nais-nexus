"use client";
import { Check, Copy } from "lucide-react";
import * as React from "react";
import { cn } from "./cn";
import { copyText } from "./copy-text";
import { IconButton } from "./icon-button";
import { iconStroke } from "./styles";
import { Tooltip } from "./tooltip";

/**
 * Where to cut. Paths keep their file name when it is short (≤ 24 chars, about 180px of mono — fits a phone);
 * a longer name keeps its last 20 characters, which carry the extension and the distinguishing end. IDs and hashes
 * keep their last 12 characters.
 */
export function splitForMiddleEllipsis(value: string, tailChars = 12): [string, string] {
  const slash = value.lastIndexOf("/");
  let cut: number;
  if (slash > 0) cut = value.length - slash <= 24 ? slash : value.length - 20;
  else cut = Math.max(0, value.length - tailChars);
  return [value.slice(0, cut), value.slice(cut)];
}

/**
 * Monospace path / ID that is shortened in the middle, so both the root and the file name stay visible
 * (spec §4 Code / PathText). The tail does not shrink (flex weights
 * would still shave a fractional pixel off it and trigger its ellipsis); it is capped at the width minus 2rem, so the
 * head always keeps room for a few characters and its ellipsis. Short heads (≤ 4 chars) skip the cap and let the
 * tail shrink instead, because a percentage cap in a shrink-to-fit cell would clip a value that fits.
 * Head and tail together read as the full value for screen readers; the tooltip shows it whole. The copy button works
 * on plain http (copyText falls back to execCommand).
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
  // A head of 4 characters or fewer is narrower than the 2rem reserve, so the cap would clip a value that fits.
  const longHead = head.length > 4;
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
        <span tabIndex={0} className="flex min-w-0 rounded-xs outline-none focus-visible:outline-2 focus-visible:outline-focus">
          <span data-part="head" className="min-w-0 truncate">
            {head}
          </span>
          <span data-part="tail" className={cn("truncate whitespace-pre", longHead ? "max-w-[calc(100%-2rem)] shrink-0" : "min-w-0")}>
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
