import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "./errors";

export function makeQueryClient({ retry = true, onError, onSuccess }: { retry?: boolean; onError?: (error: unknown) => void; onSuccess?: () => void } = {}): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({ onError, onSuccess }),
    mutationCache: new MutationCache({ onError, onSuccess }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // 4xx are answers, not glitches: never retry them.
        retry: retry ? (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2 : false,
      },
      mutations: { retry: false },
    },
  });
}
