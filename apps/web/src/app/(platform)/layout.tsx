import type { ReactNode } from "react";
import { AuthGate } from "@/features/auth/components/auth-gate";
import { PlatformShell } from "@/features/shell/platform-shell";

export const dynamic = "force-dynamic";

/** Protected subtree only: public pages and /blocked live outside this group and are never gated. */
export default function PlatformLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <PlatformShell>{children}</PlatformShell>
    </AuthGate>
  );
}
