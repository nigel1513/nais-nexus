import { cn } from "./cn";

/** Static slate-3 block the size of the content it stands in for. No shimmer or pulse (spec §4). */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" data-skeleton="" className={cn("rounded-sm bg-bg-hover", className)} />;
}
