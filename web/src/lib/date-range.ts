/**
 * Date ranges for reports/analytics. The api takes `[from, to)` as ISO
 * instants (or YYYY-MM-DD = UTC day); the panel always sends instants
 * computed from the viewer's LOCAL midnight so "today" means the user's day.
 * Ranges are capped at 366 days by the api.
 */

export type RangePreset = "today" | "24h" | "7d" | "30d" | "90d" | "mtd" | "custom";

export interface DateRange {
  preset: RangePreset;
  /** inclusive local day (YYYY-MM-DD) for custom ranges */
  fromDay?: string;
  /** inclusive local day (YYYY-MM-DD) for custom ranges */
  toDay?: string;
}

export const PRESETS: Array<{ value: Exclude<RangePreset, "custom">; label: string }> = [
  { value: "today", label: "Today" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "mtd", label: "Month to date" },
];

export const MAX_RANGE_DAYS = 366;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addLocalDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Parse YYYY-MM-DD as local midnight. */
export function parseLocalDay(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? d : null;
}

export interface ResolvedRange {
  from: Date;
  to: Date;
  /** ISO strings to send as from/to (or from_date/to_date) */
  fromIso: string;
  toIso: string;
  granularity: "hour" | "day";
  label: string;
}

/** Turn a preset/custom range into concrete instants. `now` is injectable for tests. */
export function resolveRange(range: DateRange, now: Date = new Date()): ResolvedRange {
  let from: Date;
  let to: Date;
  let label: string;
  const today = startOfLocalDay(now);
  switch (range.preset) {
    case "today":
      from = today;
      to = addLocalDays(today, 1);
      label = "Today";
      break;
    case "24h":
      to = new Date(Math.ceil(now.getTime() / HOUR) * HOUR);
      from = new Date(to.getTime() - 24 * HOUR);
      label = "Last 24 hours";
      break;
    case "30d":
      to = addLocalDays(today, 1);
      from = addLocalDays(today, -29);
      label = "Last 30 days";
      break;
    case "90d":
      to = addLocalDays(today, 1);
      from = addLocalDays(today, -89);
      label = "Last 90 days";
      break;
    case "mtd":
      to = addLocalDays(today, 1);
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      label = "Month to date";
      break;
    case "custom": {
      const f = range.fromDay ? parseLocalDay(range.fromDay) : null;
      const t = range.toDay ? parseLocalDay(range.toDay) : null;
      from = f ?? addLocalDays(today, -6);
      to = t ? addLocalDays(t, 1) : addLocalDays(today, 1);
      if (to <= from) to = addLocalDays(from, 1);
      if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY) {
        from = new Date(to.getTime() - MAX_RANGE_DAYS * DAY);
      }
      label = `${range.fromDay ?? ""} – ${range.toDay ?? ""}`;
      break;
    }
    case "7d":
    default:
      to = addLocalDays(today, 1);
      from = addLocalDays(today, -6);
      label = "Last 7 days";
  }
  const spanH = (to.getTime() - from.getTime()) / HOUR;
  return {
    from,
    to,
    fromIso: from.toISOString(),
    toIso: to.toISOString(),
    granularity: spanH <= 48 ? "hour" : "day",
    label,
  };
}

/** Serialize to / from URL params (`range=7d` or `range=custom&from=..&to=..`). */
export function rangeFromParams(get: (k: string) => string | null, fallback: RangePreset = "7d"): DateRange {
  const raw = get("range");
  const preset = (["today", "24h", "7d", "30d", "90d", "mtd", "custom"] as const).find((p) => p === raw) ?? fallback;
  if (preset !== "custom") return { preset };
  return { preset, fromDay: get("from") ?? undefined, toDay: get("to") ?? undefined };
}

/**
 * Bucket start instants for a resolved range at its granularity; used to fill
 * gaps in timeseries responses so charts show zeros rather than joining over
 * missing hours/days.
 */
export function bucketStarts(r: Pick<ResolvedRange, "from" | "to" | "granularity">): Date[] {
  const out: Date[] = [];
  if (r.granularity === "hour") {
    const start = Math.floor(r.from.getTime() / HOUR) * HOUR;
    for (let t = start; t < r.to.getTime(); t += HOUR) out.push(new Date(t));
  } else {
    for (let d = startOfLocalDay(r.from); d < r.to; d = addLocalDays(d, 1)) out.push(d);
  }
  return out;
}

/** Key for matching api points to buckets: hour → epoch hour; day → local YYYY-MM-DD. */
export function bucketKey(d: Date, granularity: "hour" | "day"): string {
  if (granularity === "hour") return String(Math.floor(d.getTime() / HOUR));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Key for an api point. A day bucket given as a date ("2026-10-18") or as a UTC
 * midnight ("2026-10-18T00:00:00Z", a UTC-day bucket) is matched on that
 * calendar date; any other instant (e.g. an org-timezone midnight) is mapped to
 * the viewer's local day.
 */
export function pointKey(t: string, granularity: "hour" | "day"): string {
  if (granularity === "day") {
    const m = /^(\d{4}-\d{2}-\d{2})(?:$|T00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00)$)/.exec(t);
    if (m) return m[1];
  }
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? t : bucketKey(d, granularity);
}
