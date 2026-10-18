"use client";

import type { ReactNode } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export interface LegendItem {
  label: string;
  color: string;
  /** mirror the mark: line for line charts, rect for bars/areas */
  shape?: "line" | "rect";
}

/** Legend row: colored key beside text-token label (text never wears the series color). */
export function ChartLegend({ items, className }: { items: LegendItem[]; className?: string }) {
  if (items.length < 2) return null;
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground", className)}>
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5">
          {it.shape === "line" ? (
            <span aria-hidden className="inline-block h-0.5 w-3 rounded-full" style={{ background: it.color }} />
          ) : (
            <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: it.color }} />
          )}
          {it.label}
        </li>
      ))}
    </ul>
  );
}

export interface TooltipRow {
  label: string;
  value: ReactNode;
  color?: string;
}

/**
 * Tooltip body: heading, then one row per series - value strong, series name
 * secondary, keyed by a short line in the series color.
 */
export function TooltipBox({ title, rows }: { title: ReactNode; rows: TooltipRow[] }) {
  return (
    <div className="pointer-events-none min-w-[10rem] rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <div className="mb-1.5 font-medium text-muted-foreground">{title}</div>
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-2">
            {r.color ? (
              <span aria-hidden className="inline-block h-0.5 w-3 shrink-0 rounded-full" style={{ background: r.color }} />
            ) : null}
            <span className="font-semibold tabular-nums text-foreground">{r.value}</span>
            <span className="text-muted-foreground">{r.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface DataTableColumn<T> {
  header: string;
  cell: (row: T) => ReactNode;
  align?: "left" | "right";
}

/** Compact table used as the "Table view" of a chart. */
export function ChartTable<T>({
  columns,
  rows,
  rowKey,
  caption,
}: {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T, i: number) => string;
  caption: string;
}) {
  return (
    <Table>
      <caption className="sr-only">{caption}</caption>
      <TableHeader>
        <TableRow>
          {columns.map((c) => (
            <TableHead key={c.header} className={cn("whitespace-nowrap", c.align === "right" && "text-right")}>
              {c.header}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r, i) => (
          <TableRow key={rowKey(r, i)}>
            {columns.map((c) => (
              <TableCell key={c.header} className={cn("tabular-nums", c.align === "right" && "text-right")}>
                {c.cell(r)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
