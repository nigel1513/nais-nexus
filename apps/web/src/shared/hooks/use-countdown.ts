"use client";
import { useEffect, useState } from "react";

const secondsLeft = (expiresAt: string | null) => (expiresAt ? Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000)) : 0);

export function useCountdown(expiresAt: string | null): number {
  const [left, setLeft] = useState(() => secondsLeft(expiresAt));
  useEffect(() => {
    setLeft(secondsLeft(expiresAt));
    if (!expiresAt) return;
    const id = setInterval(() => {
      const s = secondsLeft(expiresAt);
      setLeft(s);
      if (s === 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  return left;
}

export function formatCountdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
