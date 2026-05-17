/**
 * Dashboard-local hook for the admin-only virtual keys inventory
 * endpoint. Kept out of the generated api-client because it is a
 * recently added endpoint and we would rather not regenerate the whole
 * client for a single read-only route.
 */
import { useQuery } from "@tanstack/react-query";
import type { VirtualKeysResponse } from "@workspace/api-client-react/schemas";

const VIRTUAL_KEYS_URL = "/api/v1/status/virtual-keys";

export const virtualKeysQueryKey = [VIRTUAL_KEYS_URL] as const;

async function fetchVirtualKeys(signal?: AbortSignal): Promise<VirtualKeysResponse | null> {
  const res = await fetch(VIRTUAL_KEYS_URL, { signal, headers: { Accept: "application/json" } });
  // 401 / 403 are expected when the dashboard is opened without an admin
  // session. Surface as "no data" rather than throwing so the panel can
  // render an empty state gracefully.
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new Error(`virtual-keys fetch failed: ${res.status}`);
  return (await res.json()) as VirtualKeysResponse;
}

export function useVirtualKeys() {
  return useQuery({
    queryKey: virtualKeysQueryKey,
    queryFn: ({ signal }) => fetchVirtualKeys(signal),
    refetchInterval: 5000,
    retry: false,
  });
}
