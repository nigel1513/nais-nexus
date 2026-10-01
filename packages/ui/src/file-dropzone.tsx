"use client";
import { Upload } from "lucide-react";
import * as React from "react";
import { buttonClass } from "./button";
import { cn } from "./cn";

const focusRing = "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring";

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
  return (
    <div
      role="group"
      aria-label={label}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (!disabled && files.length) onFiles(files);
      }}
      className={cn("flex flex-col items-center gap-3 rounded-lg border-2 border-dashed border-border p-6 text-center", over && "border-primary bg-muted")}
    >
      <Upload aria-hidden="true" className="h-6 w-6" />
      <p className="font-medium">{label}</p>
      {hint ? <p id={hintId} className="text-sm text-muted-foreground">{hint}</p> : null}
      <div className="flex flex-wrap justify-center gap-2">
        <input id={fileId} type="file" multiple className="peer sr-only" disabled={disabled} aria-describedby={hint ? hintId : undefined} onChange={pick} />
        <label htmlFor={fileId} className={cn(buttonClass("outline", "sm", disabled ? "opacity-60" : "cursor-pointer"), focusRing)}>
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
        <label htmlFor={folderId} className={cn(buttonClass("outline", "sm", disabled ? "opacity-60" : "cursor-pointer"), focusRing)}>
          {folderButtonLabel}
        </label>
      </div>
    </div>
  );
}
