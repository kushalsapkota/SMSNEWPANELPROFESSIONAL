"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, qk } from "@/lib/api";
import { useSession } from "@/lib/auth/session";

export interface RouteOption {
  value: string;
  label: string;
  template_mode: boolean;
  enabled: boolean;
}

/**
 * Routes the acting org can use: admin = every route (GET /api/routes, full
 * rows), reseller / client = assigned routes (id, name, template_mode).
 */
export function useRouteOptions(enabled = true): { options: RouteOption[]; isLoading: boolean; error: unknown } {
  const { role } = useSession();
  const admin = role === "SUPER_ADMIN";
  const params = { page_size: 200 } as const;
  const q = useQuery({
    // own key: the cached value is mapped options, not the paginated envelope
    queryKey: [...qk.routes.all, "options", admin ? "all" : "assigned"],
    queryFn: async (): Promise<RouteOption[]> => {
      if (admin) {
        const res = await api.routes.list(params);
        return res.items.map((r) => ({ value: r.id, label: r.name, template_mode: r.template_mode, enabled: r.enabled }));
      }
      const res = await api.routes.listAssigned(params);
      return res.items.map((r) => ({ value: r.id, label: r.name, template_mode: r.template_mode, enabled: true }));
    },
    enabled,
    staleTime: 60_000,
  });
  const options = useMemo(() => q.data ?? [], [q.data]);
  return { options, isLoading: q.isLoading, error: q.error };
}
