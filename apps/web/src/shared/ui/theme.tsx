"use client";
import { ThemeProvider as NextThemes, useTheme } from "next-themes";
import type { ReactNode } from "react";

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemes attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange storageKey="nais-theme">
      {children}
    </NextThemes>
  );
}

export type ThemeChoice = "system" | "light" | "dark";
export function useThemeChoice(): { choice: ThemeChoice; setChoice: (c: ThemeChoice) => void } {
  const { theme, setTheme } = useTheme();
  return { choice: (theme as ThemeChoice) ?? "system", setChoice: setTheme };
}
