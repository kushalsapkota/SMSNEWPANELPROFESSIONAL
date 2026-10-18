"use client";

import { useQuery } from "@tanstack/react-query";
import { api, qk } from "@/lib/api";
import { useSession } from "@/lib/auth/session";

/**
 * Display currency of the acting org (its accounts_balance.currency).
 * SUPER_ADMIN has no balance row and falls back to USD.
 */
export function useCurrency(): string {
  const { org, role } = useSession();
  const q = useQuery({
    queryKey: qk.orgs.balance(org.id),
    queryFn: () => api.orgs.balance(org.id),
    enabled: role !== "SUPER_ADMIN",
    staleTime: 5 * 60_000,
    retry: false,
  });
  return q.data?.currency || "USD";
}
