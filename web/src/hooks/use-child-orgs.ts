"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Option } from "@/components/shared/form-fields";
import { api, qk } from "@/lib/api";
import { useSession } from "@/lib/auth/session";

/** Options for the acting org's direct children (admin → resellers, reseller → clients). */
export function useChildOrgOptions(enabled = true): { options: Option[]; isLoading: boolean } {
  const { role } = useSession();
  const childRole = role === "SUPER_ADMIN" ? "RESELLER" : role === "RESELLER" ? "CLIENT" : null;
  const params = { role: childRole ?? undefined, page_size: 200 } as const;
  const q = useQuery({
    queryKey: qk.orgs.list(params),
    queryFn: () => api.orgs.list(params),
    enabled: enabled && childRole !== null,
    staleTime: 60_000,
  });
  const options = useMemo(() => (q.data?.items ?? []).map((o) => ({ value: o.id, label: o.name })), [q.data]);
  return { options, isLoading: q.isLoading };
}
