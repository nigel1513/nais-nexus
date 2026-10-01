"use client";
import { Upload } from "lucide-react";
import * as React from "react";
import { buttonClass } from "./button";
import { cn } from "./cn";
import { iconStroke } from "./styles";

const focusRing = "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus";

/** Dashed 1px drop area with file and folder pickers (spec §6 versions: drop zone). */
export function FileDropzone({
  label,
  hint,
  fileButtonLabel,
  folderButtonLabel,
  disabled,
  onFiles,
}: {
  label: string;
  hint?: string;
  fileButtonLabel: string;
  folderButtonLabel: string;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
}) {
  const [over, setOver] = React.useState(false);
  const fileId = React.useId();
  const folderId = React.useId();
  const hintId = React.useId();
  const folderRef = React.useCallback((el: HTMLInputElement | null) => {
    if (el) el.setAttribute("webkitdirectory", "");
  }, []);
  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length) onFiles(files);
    e.target.value = "";
  };
  const pickerClass = cn(buttonClass("secondary", "sm"), disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer", focusRing);
  return (
    <div
      role="group"
      aria-label={label}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={(e) => {
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (!disabled && files.length) onFiles(files);
      }}
      className={cn(
        "flex flex-col items-center gap-2 rounded-md border border-dashed border-border-strong bg-bg-subtle px-6 py-8 text-center",
        over && "border-accent bg-accent-soft",
      )}
    >
      <Upload aria-hidden="true" className="size-5 text-fg-muted" strokeWidth={iconStroke} />
      <p className="text-body font-medium text-fg">{label}</p>
      {hint ? (
        <p id={hintId} className="text-small text-fg-muted">
          {hint}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        <input id={fileId} type="file" multiple className="peer sr-only" disabled={disabled} aria-describedby={hint ? hintId : undefined} onChange={pick} />
        <label htmlFor={fileId} className={pickerClass}>
          {fileButtonLabel}
        </label>
        <input
          id={folderId}
          ref={folderRef}
          type="file"
          multiple
          className="peer sr-only"
          disabled={disabled}
          aria-describedby={hint ? hintId : undefined}
          onChange={pick}
        />
        <label htmlFor={folderId} className={pickerClass}>
          {folderButtonLabel}
        </label>
      </div>
    </div>
  );
}
