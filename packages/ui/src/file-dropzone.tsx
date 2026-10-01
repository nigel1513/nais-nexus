"use client";
import { Upload } from "lucide-react";
import * as React from "react";
import { buttonClass } from "./button";
import { cn } from "./cn";

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
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!disabled) onFiles(Array.from(e.dataTransfer.files));
      }}
      className={cn("flex flex-col items-center gap-3 rounded-lg border-2 border-dashed border-border p-6 text-center", over && "border-primary bg-muted")}
    >
      <Upload aria-hidden="true" className="h-6 w-6" />
      <p className="font-medium">{label}</p>
      {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
      <div className="flex flex-wrap justify-center gap-2">
        <label htmlFor={fileId} className={buttonClass("outline", "sm", disabled ? "opacity-60" : "cursor-pointer")}>
          {fileButtonLabel}
        </label>
        <input id={fileId} type="file" multiple className="sr-only" disabled={disabled} onChange={pick} />
        <label htmlFor={folderId} className={buttonClass("outline", "sm", disabled ? "opacity-60" : "cursor-pointer")}>
          {folderButtonLabel}
        </label>
        <input id={folderId} ref={folderRef} type="file" multiple className="sr-only" disabled={disabled} onChange={pick} />
      </div>
    </div>
  );
}
