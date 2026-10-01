"use client";
import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "@/shared/api/client";
import type { Me, OrgRole } from "@/shared/api/types";

export function useMe(enabled = true) {
  return useQuery({ queryKey: ["getMe", {}], queryFn: () => unwrap(api.GET("/me")) as Promise<Me>, staleTime: 60_000, enabled });
}

/** Only valid below <MeGate>, which renders children after getMe succeeded. */
export function useMeData(): Me {
  const { data } = useMe();
  if (!data) throw new Error("useMeData() must be used inside <MeGate>");
  return data;
}

export function hasOrgRole(me: Me | undefined, ...roles: OrgRole[]): boolean {
  return !!me && roles.some((r) => me.org_roles.includes(r));
}
