import * as React from "react";
import { cn } from "./cn";

const control =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring aria-[invalid=true]:border-danger disabled:opacity-60";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(control, "h-10", className)} {...props} />;
});

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...props },
  ref,
) {
  return <textarea ref={ref} className={cn(control, "min-h-24", className)} {...props} />;
});

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...props }, ref) {
  return <select ref={ref} className={cn(control, "h-10", className)} {...props} />;
});

export const Checkbox = React.forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">>(function Checkbox(
  { className, ...props },
  ref,
) {
  return <input ref={ref} type="checkbox" className={cn("h-5 w-5 accent-primary", className)} {...props} />;
});

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  // eslint-disable-next-line jsx-a11y/label-has-associated-control -- htmlFor is passed by callers
  return <label className={cn("text-sm font-medium", className)} {...props} />;
}

export type FieldA11y = { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean; "aria-required"?: boolean };

export function FormField({
  id,
  label,
  required,
  requiredLabel,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  requiredLabel?: string;
  hint?: React.ReactNode;
  error?: string;
  children: (a11y: FieldA11y) => React.ReactNode;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>
        {label}
        {required && requiredLabel ? <span className="ml-1 text-muted-foreground">{requiredLabel}</span> : null}
      </Label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined, "aria-required": required || undefined })}
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
