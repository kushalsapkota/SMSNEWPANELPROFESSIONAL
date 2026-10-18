"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

/** Active tab stored in `?tab=` so tabs are linkable and survive reloads. */
export function useTabParam<T extends string>(allowed: readonly T[], fallback: T, key = "tab") {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const raw = search.get(key);
  const tab = (allowed as readonly string[]).includes(raw ?? "") ? (raw as T) : fallback;
  const setTab = useCallback(
    (next: string) => {
      // Drop other tables' paging params when switching tabs.
      const params = new URLSearchParams();
      if (next !== fallback) params.set(key, next);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, fallback, key],
  );
  return [tab, setTab] as const;
}
