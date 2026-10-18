"use client";

import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState, ErrorState } from "@/components/shared/states";
import { PAGE_SIZES, type TableState } from "@/hooks/use-table-state";
import type { Paginated } from "@/lib/api/types";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface Column<T> {
  /** Unique id; also the `sort` value sent to the api when sortable. */
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  sortable?: boolean;
  className?: string;
  headerClassName?: string;
  /** Hide below the `sm` breakpoint to keep tables usable at 400px. */
  hideOnMobile?: boolean;
  align?: "left" | "right" | "center";
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  /** Paginated envelope (server mode) or a plain array (client mode, no pager). */
  data: Paginated<T> | T[] | undefined;
  rowKey: (row: T) => string | number;
  isLoading?: boolean;
  isFetching?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** Server pagination/sorting state (from useTableState). */
  state?: TableState;
  onStateChange?: (patch: Partial<TableState>) => void;
  toolbar?: ReactNode;
  empty?: { title?: ReactNode; description?: ReactNode; action?: ReactNode };
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  className?: string;
  caption?: string;
}

/**
 * Generic table with server-side pagination & sorting, loading skeletons,
 * empty and error states. Pair with `useTableState` + `useQuery`:
 *
 *   const t = useTableState({ filters: ["q"] });
 *   const q = useQuery({ queryKey: qk.orgs.list(t.params), queryFn: () => api.orgs.list(t.params),
 *                        placeholderData: keepPreviousData });
 *   <DataTable columns={cols} data={q.data} isLoading={q.isLoading} error={q.error}
 *              state={t.state} onStateChange={t.setState} rowKey={(r) => r.id} />
 */
export function DataTable<T>({
  columns,
  data,
  rowKey,
  isLoading,
  isFetching,
  error,
  onRetry,
  state,
  onStateChange,
  toolbar,
  empty,
  onRowClick,
  rowClassName,
  className,
  caption,
}: DataTableProps<T>) {
  const rows = Array.isArray(data) ? data : (data?.items ?? []);
  const paginated = data && !Array.isArray(data) ? data : undefined;

  const toggleSort = (col: Column<T>) => {
    if (!col.sortable || !onStateChange) return;
    const active = state?.sort === col.id;
    const order = active && state?.order === "asc" ? "desc" : "asc";
    onStateChange({ sort: col.id, order, page: 1 });
  };

  const alignClass = (a?: Column<T>["align"]) =>
    a === "right" ? "text-right" : a === "center" ? "text-center" : undefined;

  return (
    <div className={cn("space-y-3", className)}>
      {toolbar ? <div className="flex flex-wrap items-center gap-2">{toolbar}</div> : null}
      <div className="relative overflow-x-auto rounded-md border">
        {isFetching && !isLoading ? (
          <div className="absolute right-2 top-2 z-10" aria-hidden>
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : null}
        <Table>
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <TableHeader>
            <TableRow>
              {columns.map((col) => {
                const active = state?.sort === col.id;
                const ariaSort = active ? (state?.order === "desc" ? "descending" : "ascending") : undefined;
                return (
                  <TableHead
                    key={col.id}
                    aria-sort={col.sortable ? (ariaSort ?? "none") : undefined}
                    className={cn(
                      "whitespace-nowrap",
                      col.hideOnMobile && "hidden sm:table-cell",
                      alignClass(col.align),
                      col.headerClassName,
                    )}
                  >
                    {col.sortable && onStateChange ? (
                      <button
                        type="button"
                        className="-ml-2 inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-accent"
                        onClick={() => toggleSort(col)}
                      >
                        {col.header}
                        {active ? (
                          state?.order === "desc" ? (
                            <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                          ) : (
                            <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                          )
                        ) : (
                          <ArrowUpDown className="h-3.5 w-3.5 opacity-50" aria-hidden />
                        )}
                      </button>
                    ) : (
                      col.header
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={`sk-${i}`}>
                  {columns.map((col) => (
                    <TableCell key={col.id} className={cn(col.hideOnMobile && "hidden sm:table-cell")}>
                      <Skeleton className="h-5 w-full max-w-[12rem]" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : error ? (
              <TableRow>
                <TableCell colSpan={columns.length}>
                  <ErrorState error={error} onRetry={onRetry} />
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length}>
                  <EmptyState
                    title={empty?.title ?? "No results"}
                    description={empty?.description}
                    action={empty?.action}
                  />
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow
                  key={rowKey(row)}
                  className={cn(onRowClick && "cursor-pointer", rowClassName?.(row))}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === "Enter" && e.target === e.currentTarget) onRowClick(row);
                        }
                      : undefined
                  }
                  tabIndex={onRowClick ? 0 : undefined}
                >
                  {columns.map((col) => (
                    <TableCell
                      key={col.id}
                      className={cn(
                        col.hideOnMobile && "hidden sm:table-cell",
                        alignClass(col.align),
                        col.className,
                      )}
                    >
                      {col.cell(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {paginated && state && onStateChange ? (
        <Pager total={paginated.total} state={state} onStateChange={onStateChange} />
      ) : null}
    </div>
  );
}

export function Pager({
  total,
  state,
  onStateChange,
}: {
  total: number;
  state: TableState;
  onStateChange: (patch: Partial<TableState>) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / state.page_size));
  const from = total === 0 ? 0 : (state.page - 1) * state.page_size + 1;
  const to = Math.min(total, state.page * state.page_size);
  return (
    <div className="flex flex-col gap-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <div aria-live="polite">
        {formatNumber(from)}–{formatNumber(to)} of {formatNumber(total)}
      </div>
      <div className="flex items-center gap-2">
        <span className="hidden sm:inline">Rows</span>
        <Select
          value={String(state.page_size)}
          onValueChange={(v) => onStateChange({ page_size: Number(v), page: 1 })}
        >
          <SelectTrigger className="h-8 w-[72px]" aria-label="Rows per page">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZES.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          disabled={state.page <= 1}
          onClick={() => onStateChange({ page: state.page - 1 })}
          aria-label="Previous page"
        >
          <ChevronLeft />
        </Button>
        <span className="tabular-nums">
          {state.page} / {pages}
        </span>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          disabled={state.page >= pages}
          onClick={() => onStateChange({ page: state.page + 1 })}
          aria-label="Next page"
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
