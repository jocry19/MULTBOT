import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

/**
 * Query helper. The first key segment is the invalidation domain the server pushes over the
 * stream ("paper", "live", "wallet", "strategies"), so live updates refresh the right views.
 */
export function useApi<T>(domain: string, path: string | null, refetchMs?: number) {
  return useQuery({
    queryKey: [domain, path],
    queryFn: () => api.get<T>(path as string),
    enabled: path !== null,
    ...(refetchMs ? { refetchInterval: refetchMs } : {}),
  });
}

/** POST action that refreshes the given domains afterwards. */
export function useAction<B = unknown, R = unknown>(path: string | ((b: B) => string), domains: string[], bodyOf?: (b: B) => unknown) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: B) => api.post<R>(typeof path === "function" ? path(b) : path, bodyOf ? bodyOf(b) : b),
    onSuccess: async () => {
      for (const d of domains) await qc.invalidateQueries({ queryKey: [d] });
    },
  });
}
