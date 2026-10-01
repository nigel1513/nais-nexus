"use client";
import type { ReactNode } from "react";
import { useAuthReady } from "../use-auth-ready";

/** Wrap the PROTECTED subtree only: holds it back until the session is known so no first fetch goes out without a token. */
export function AuthGate({ children }: { children: ReactNode }) {
  return useAuthReady() ? <>{children}</> : null;
}
