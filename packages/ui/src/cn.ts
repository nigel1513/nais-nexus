import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge must know our token names: otherwise `text-body` (a font size) is read as a text colour and
 * silently drops `text-primary-fg` from the same class list.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["display", "title", "heading", "body", "small", "caption", "mono"],
      shadow: ["popover", "dialog", "raised"],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
