"use client";

import { BarChart3, Table2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/shared/states";
import { cn } from "@/lib/utils";

/**
 * Card wrapper for every chart: title + description, a Chart / Table toggle
 * (the table is the accessible, tooltip-free view of the same numbers),
 * loading skeleton on first load, previous render kept at reduced opacity
 * while refetching (no layout jump), and empty / error states.
 */
export function ChartCard({
  title,
  description,
  legend,
  chart,
  table,
  height = 260,
  isLoading,
  isFetching,
  error,
  onRetry,
  isEmpty,
  emptyTitle = "No data for this period",
  actions,
  className,
}: {
  title: string;
  description?: ReactNode;
  legend?: ReactNode;
  chart: ReactNode;
  table?: ReactNode;
  /** total chart height in px including the x-axis band */
  height?: number;
  isLoading?: boolean;
  isFetching?: boolean;
  error?: unknown;
  onRetry?: () => void;
  isEmpty?: boolean;
  emptyTitle?: string;
  actions?: ReactNode;
  className?: string;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  return (
    <Card className={cn("min-w-0", className)}>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0 pb-2">
        <div className="min-w-0 space-y-1">
          <CardTitle className="text-base">{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        <div className="flex items-center gap-2">
          {actions}
          {table ? (
            <div className="inline-flex rounded-md border p-0.5" role="group" aria-label={`${title} view`}>
              <button
                type="button"
                className={cn(
                  "inline-flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground",
                  view === "chart" && "bg-muted text-foreground",
                )}
                aria-pressed={view === "chart"}
                aria-label="Chart view"
                onClick={() => setView("chart")}
              >
                <BarChart3 className="h-4 w-4" aria-hidden />
              </button>
              <button
                type="button"
                className={cn(
                  "inline-flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground",
                  view === "table" && "bg-muted text-foreground",
                )}
                aria-pressed={view === "table"}
                aria-label="Table view"
                onClick={() => setView("table")}
              >
                <Table2 className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        {error ? (
          <ErrorState error={error} onRetry={onRetry} />
        ) : isLoading ? (
          <Skeleton className="w-full" style={{ height }} />
        ) : isEmpty ? (
          <div style={{ minHeight: height }} className="flex items-center justify-center">
            <EmptyState title={emptyTitle} />
          </div>
        ) : (
          <div className={cn("transition-opacity", isFetching && "opacity-60")} aria-busy={isFetching || undefined}>
            {view === "table" && table ? (
              <div className="max-h-[420px] overflow-auto">{table}</div>
            ) : (
              <>
                {legend ? <div className="mb-3">{legend}</div> : null}
                <div style={{ height }} className="w-full min-w-0">
                  {chart}
                </div>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
