import type { QueryClient } from "@tanstack/react-query";
import { api } from "./api.ts";

/**
 * Turn-window page size for the session-inspect route. Single source of
 * truth - SessionInspectView's mount query (session-inspect.tsx) imports it
 * from here rather than redeclaring it, so pagination and prefetch never
 * drift apart.
 */
export const PAGE_SIZE = 100;

/**
 * Prefetch thunk for the session detail route. The queryKey + queryFn MUST
 * stay byte-identical to SessionInspectView's mount query (session-inspect.tsx)
 * or the prefetch warms a dead cache entry.
 */
export function prefetchSessionInspect(
    queryClient: QueryClient,
    sessionId: string,
): () => Promise<unknown> {
    return () =>
        queryClient.prefetchQuery({
            queryKey: ["session-inspect", sessionId],
            queryFn: () => api.sessionInspect(sessionId, { turnOffset: 0, turnLimit: PAGE_SIZE }),
            staleTime: 5 * 60_000,
        });
}
