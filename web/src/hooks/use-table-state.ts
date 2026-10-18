"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import type { SortOrder } from "@/lib/api/types";

export interface TableState {
  page: number;
  page_size: number;
  sort?: string;
  order?: SortOrder;
}

export interface UseTableStateOptions<F extends string> {
  /** Filter names kept in the URL next to page/sort (e.g. ["q", "status"]). */
  filters?: readonly F[];
  defaultPageSize?: number;
  defaultSort?: { sort: string; order: SortOrder };
  /** Prefix URL keys so several tables can live on one page (e.g. "tx" → tx_page). */
  prefix?: string;
}

export const PAGE_SIZES = [10, 25, 50, 100] as const;

/**
 * Server-side table state (page, page_size, sort, order + filters) stored in
 * the URL search params, so it survives reloads and is shareable.
 * `params` is ready to spread into an api list call and a query key.
 */
export function useTableState<F extends string = never>(opts: UseTableStateOptions<F> = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const pre = opts.prefix ? `${opts.prefix}_` : "";
  const defaultPageSize = opts.defaultPageSize ?? 25;
  const filterNames = opts.filters;

  const state = useMemo<TableState>(() => {
    const page = Math.max(1, Number(search.get(`${pre}page`)) || 1);
    const ps = Number(search.get(`${pre}page_size`)) || defaultPageSize;
    const sort = search.get(`${pre}sort`) ?? opts.defaultSort?.sort;
    const orderRaw = search.get(`${pre}order`) ?? opts.defaultSort?.order;
    const order: SortOrder | undefined =
      orderRaw === "asc" || orderRaw === "desc" ? orderRaw : undefined;
    return { page, page_size: Math.min(200, Math.max(1, ps)), sort: sort ?? undefined, order };
  }, [search, pre, defaultPageSize, opts.defaultSort?.sort, opts.defaultSort?.order]);

  const filters = useMemo(() => {
    const out = {} as Record<F, string | undefined>;
    for (const f of filterNames ?? []) out[f] = search.get(`${pre}${f}`) ?? undefined;
    return out;
  }, [search, pre, filterNames]);

  const update = useCallback(
    (patch: Record<string, string | number | undefined | null>) => {
      const next = new URLSearchParams(search.toString());
      for (const [k, v] of Object.entries(patch)) {
        const key = `${pre}${k}`;
        if (v === undefined || v === null || v === "") next.delete(key);
        else next.set(key, String(v));
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, search, pre],
  );

  const setState = useCallback(
    (patch: Partial<TableState>) => {
      const p: Record<string, string | number | undefined> = { ...patch };
      if (patch.page === 1) p.page = undefined;
      if (patch.page_size === defaultPageSize) p.page_size = undefined;
      update(p);
    },
    [update, defaultPageSize],
  );

  const setFilter = useCallback(
    (name: F, value: string | undefined) => update({ [name]: value, page: undefined }),
    [update],
  );

  const resetFilters = useCallback(() => {
    const patch: Record<string, undefined> = { page: undefined };
    for (const f of filterNames ?? []) patch[f] = undefined;
    update(patch);
  }, [update, filterNames]);

  const params = useMemo(() => {
    const clean: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(filters as Record<string, string | undefined>)) {
      if (v !== undefined && v !== "") clean[k] = v;
    }
    return { ...state, ...clean } as TableState & Partial<Record<F, string>>;
  }, [state, filters]);

  return { state, setState, filters, setFilter, resetFilters, params };
}

export type TableStateApi = ReturnType<typeof useTableState>;
