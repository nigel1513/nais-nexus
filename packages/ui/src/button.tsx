import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import * as React from "react";
import { cn } from "./cn";
import { focusRing } from "./styles";

/**
 * Spec §4 Button. `press` (globals.css) scales to 0.97 on pointer-down; hover colours change instantly, which reads
 * as more responsive than a fade in a tool used all day.
 */
const button = cva(
  [
    "press relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-sm font-medium",
    "disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
    "[&_svg]:size-4 [&_svg]:shrink-0",
    focusRing,
  ].join(" "),
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-fg hover:bg-primary-hover disabled:hover:bg-primary",
        secondary: "border border-border bg-bg-panel text-fg hover:bg-bg-hover data-[popup-open]:bg-bg-hover disabled:hover:bg-bg-panel",
        ghost: "text-fg-muted hover:bg-bg-hover hover:text-fg data-[popup-open]:bg-bg-hover data-[popup-open]:text-fg disabled:hover:bg-transparent disabled:hover:text-fg-muted",
        danger: "bg-danger-fill text-danger-fill-fg hover:bg-danger-fill-hover disabled:hover:bg-danger-fill",
      },
      size: { sm: "h-7 px-2.5 text-small", md: "h-8 px-3 text-body", lg: "h-10 px-4 text-body" },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

/** Old names, mapped until Task 13 removes them. `link` keeps an underline. */
const LEGACY = { default: "primary", outline: "secondary", destructive: "danger", link: "ghost" } as const;
type Modern = NonNullable<VariantProps<typeof button>["variant"]>;
export type ButtonVariant = Modern | keyof typeof LEGACY;
export type ButtonSize = "sm" | "md" | "lg" | "default" | "icon";

function normVariant(v?: ButtonVariant): Modern {
  if (!v) return "secondary";
  return (LEGACY as Record<string, Modern>)[v] ?? (v as Modern);
}
function normSize(s?: ButtonSize): "sm" | "md" | "lg" {
  return s === "sm" || s === "lg" ? s : "md";
}

/** Classes for links and labels that look like a button. */
export function buttonClass(variant?: ButtonVariant, size?: ButtonSize, className?: string): string {
  return cn(
    button({ variant: normVariant(variant), size: normSize(size) }),
    size === "icon" && "w-8 px-0",
    variant === "link" && "underline underline-offset-4",
    className,
  );
}

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Disables the button and swaps the content for a spinner without changing its width. */
  loading?: boolean;
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, loading, disabled, children, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={buttonClass(variant, size, cn(loading && "disabled:cursor-wait disabled:opacity-100", className))}
      {...props}
    >
      {/* opacity, not visibility: the label must stay in the accessible name while it is hidden. */}
      <span className={loading ? "inline-flex items-center gap-1.5 opacity-0" : "contents"}>{children}</span>
      {loading ? <Loader2 aria-hidden="true" className="absolute animate-spin" /> : null}
    </button>
  );
});
