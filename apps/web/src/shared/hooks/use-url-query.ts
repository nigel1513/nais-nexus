"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

/** Read the query string and patch it with router.replace (filters stay shareable and survive Back — M10 §7.4). */
export function useUrlQuery(): [URLSearchParams, (patch: Record<string, string | string[] | null>) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const set = useCallback(
    (patch: Record<string, string | string[] | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(patch)) {
        next.delete(key);
        if (value === null) continue;
        for (const v of Array.isArray(value) ? value : [value]) if (v !== "") next.append(key, v);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );
  return [new URLSearchParams(params.toString()), set];
}
