import type { QueryClient } from "@tanstack/react-query";
import { setAccessTokenGetter } from "@/shared/api/client";

/** Install the refreshed token first, so the retries triggered by the invalidation cannot carry the stale one. */
export async function applyRefreshedToken(client: QueryClient, accessToken: string): Promise<void> {
  setAccessTokenGetter(() => accessToken);
  await client.invalidateQueries();
}
