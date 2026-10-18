"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";

/**
 * Named filters kept in the URL (shareable, survive reloads). `set` applies
 * several changes in ONE navigation so concurrent updates don't clobber each
 * other.
 */
export function useUrlParams<K extends string>(names: readonly K[]) {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const values = useMemo(() => {
    const out = {} as Record<K, string | undefined>;
    for (const n of names) out[n] = search.get(n) ?? undefined;
    return out;
    // names is a constant tuple at every call site
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  const set = useCallback(
    (patch: Partial<Record<K, string | undefined>>) => {
      const p = new URLSearchParams(search.toString());
      for (const [k, v] of Object.entries(patch) as Array<[string, string | undefined]>) {
        if (v === undefined || v === "") p.delete(k);
        else p.set(k, v);
      }
      const qs = p.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [search, router, pathname],
  );
  const clear = useCallback(() => {
    const p = new URLSearchParams(search.toString());
    for (const n of names) p.delete(n);
    p.delete("range");
    p.delete("from");
    p.delete("to");
    const qs = p.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, router, pathname]);
  return { values, set, clear };
}
