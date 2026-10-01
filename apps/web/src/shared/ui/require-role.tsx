"use client";
import type { ReactNode } from "react";
import { ApiError } from "@/shared/api/errors";
import type { OrgRole } from "@/shared/api/types";
import { hasOrgRole, useMe } from "@/shared/hooks/use-me";
import { ErrorView } from "./state-views";

/** Convenience gate only — the server still decides (M10 §1). Renders a 403 notice, not a redirect (M10 §6). */
export function RequireRole({ anyOf, children }: { anyOf: OrgRole[]; children: ReactNode }) {
  const { data: me } = useMe();
  if (!me) return null;
  if (!hasOrgRole(me, ...anyOf)) return <ErrorView error={new ApiError(403, "FORBIDDEN", "role required", null)} />;
  return <>{children}</>;
}
