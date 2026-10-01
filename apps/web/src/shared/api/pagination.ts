import type { InfiniteData } from "@tanstack/react-query";
import type { Page } from "./types";

export function flattenPages<T>(data: InfiniteData<Page<T>> | undefined): T[] {
  return data?.pages.flatMap((p) => p.items) ?? [];
}

export function nextCursor<T>(last: Page<T>): string | undefined {
  return last.page.has_more && last.page.next_cursor ? last.page.next_cursor : undefined;
}
