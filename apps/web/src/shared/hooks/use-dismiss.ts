"use client";
import { useEffect, type RefObject } from "react";

/** Calls onDismiss on a pointer press outside `ref` while `open`. Escape handling stays with the caller (it restores focus). */
export function useOutsideDismiss(open: boolean, ref: RefObject<HTMLElement | null>, onDismiss: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) onDismiss();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [open, ref, onDismiss]);
}
