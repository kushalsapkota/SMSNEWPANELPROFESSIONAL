"use client";

import { CalendarDays, Check, ChevronDown } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  type DateRange,
  MAX_RANGE_DAYS,
  PRESETS,
  type RangePreset,
  rangeFromParams,
  resolveRange,
} from "@/lib/date-range";
import { isoDay } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Date range kept in the URL (`?range=7d` or `?range=custom&from=…&to=…`). */
export function useDateRangeParam(fallback: RangePreset = "7d") {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const range = useMemo(() => rangeFromParams((k) => search.get(k), fallback), [search, fallback]);
  // Recompute "now"-relative instants at most once per minute so query keys stay stable.
  const minute = Math.floor(Date.now() / 60_000);
  const resolved = useMemo(
    () => resolveRange(range, new Date(minute * 60_000)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [range.preset, range.fromDay, range.toDay, minute],
  );
  const setRange = useCallback(
    (next: DateRange) => {
      const p = new URLSearchParams(search.toString());
      p.delete("from");
      p.delete("to");
      p.delete("cursor");
      if (next.preset === fallback) p.delete("range");
      else p.set("range", next.preset);
      if (next.preset === "custom") {
        if (next.fromDay) p.set("from", next.fromDay);
        if (next.toDay) p.set("to", next.toDay);
      }
      const qs = p.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [search, router, pathname, fallback],
  );
  return { range, resolved, setRange };
}

/** Preset rows + custom range behind a hairline in the footer. */
export function DateRangePicker({
  value,
  onChange,
  className,
  presets = PRESETS,
}: {
  value: DateRange;
  onChange: (r: DateRange) => void;
  className?: string;
  presets?: typeof PRESETS;
}) {
  const [open, setOpen] = useState(false);
  const today = isoDay();
  const [from, setFrom] = useState(value.fromDay ?? isoDay(new Date(Date.now() - 6 * 86_400_000)));
  const [to, setTo] = useState(value.toDay ?? today);
  const label =
    value.preset === "custom"
      ? `${value.fromDay ?? "…"} → ${value.toDay ?? "…"}`
      : (presets.find((p) => p.value === value.preset)?.label ?? "Last 7 days");
  const spanDays = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
  const customError =
    !from || !to
      ? "Pick both days"
      : spanDays < 1
        ? "Start must be on or before end"
        : spanDays > MAX_RANGE_DAYS
          ? `At most ${MAX_RANGE_DAYS} days`
          : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className={cn("w-full justify-between sm:w-auto", className)} aria-label={`Date range: ${label}`}>
          <span className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4" aria-hidden />
            {label}
          </span>
          <ChevronDown className="h-4 w-4 opacity-60" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1">
        <ul role="listbox" aria-label="Date range presets">
          {presets.map((p) => {
            const selected = value.preset === p.value;
            return (
              <li key={p.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={cn(
                    "flex w-full items-center justify-between rounded-sm px-3 py-2 text-sm hover:bg-accent",
                    selected && "font-medium",
                  )}
                  onClick={() => {
                    onChange({ preset: p.value });
                    setOpen(false);
                  }}
                >
                  {p.label}
                  {selected ? <Check className="h-4 w-4" strokeWidth={3} aria-hidden /> : null}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="mt-1 space-y-2 border-t p-3">
          <p className="text-xs font-medium text-muted-foreground">Custom range</p>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="range-from" className="text-xs">
                From
              </Label>
              <Input id="range-from" type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="range-to" className="text-xs">
                To
              </Label>
              <Input id="range-to" type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
          {customError ? <p className="text-xs text-destructive">{customError}</p> : null}
          <Button
            size="sm"
            className="w-full"
            disabled={!!customError}
            onClick={() => {
              onChange({ preset: "custom", fromDay: from, toDay: to });
              setOpen(false);
            }}
          >
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
