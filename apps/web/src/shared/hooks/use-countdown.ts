"use client";
import { useEffect, useState } from "react";

const secondsLeft = (expiresAt: string | null) => (expiresAt ? Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000)) : 0);

/** Derived on every render so a freshly arrived (or already past) expiry never shows a stale value for a frame. */
export function useCountdown(expiresAt: string | null): number {
  const [, tick] = useState(0);
  const left = secondsLeft(expiresAt);
  const running = !!expiresAt && left > 0;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running, expiresAt]);
  return left;
}

export function formatCountdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
