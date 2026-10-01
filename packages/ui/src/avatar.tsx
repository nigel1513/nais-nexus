import { cn } from "./cn";

const PALETTE = [
  "bg-bg-active text-fg-muted",
  "bg-accent-soft text-accent-fg",
  "bg-info-soft text-info",
  "bg-success-soft text-success",
  "bg-warning-soft text-warning",
] as const;

const SIZE = { 20: "size-5 text-[10px]", 24: "size-6 text-[11px]", 32: "size-8 text-caption" } as const;

/** Korean names: the family name (first syllable). Latin names: first letters of the first two words. */
export function initials(name: string): string {
  const n = name.trim();
  if (!n) return "?";
  if (/^[가-힣]/.test(n)) return n[0]!;
  const words = n.split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase();
}

/** Stable palette index from the name, so a person keeps one colour everywhere. */
export function avatarTone(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % PALETTE.length;
}

/** Initials avatar, 20/24/32px (spec §4). No photos. Decorative when the name is printed next to it. */
export function Avatar({ name, size = 24, decorative, className }: { name: string; size?: 20 | 24 | 32; decorative?: boolean; className?: string }) {
  return (
    <span
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative || undefined}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold leading-none",
        SIZE[size],
        PALETTE[avatarTone(name)],
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}
