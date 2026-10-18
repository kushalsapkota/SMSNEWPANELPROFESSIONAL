import type { BreakdownRow, OrgRole, TimeseriesPoint } from "@/lib/api/types";
import { bucketKey, bucketStarts, pointKey, type ResolvedRange } from "@/lib/date-range";

export interface FilledPoint {
  [key: string]: number | null;
  /** bucket start, epoch ms */
  t: number;
  messages: number;
  delivered: number;
  failed: number;
  /** in flight / unknown = messages - delivered - failed */
  other: number;
  revenue_micros: number;
  cost_micros: number;
  /** revenue - cost (0 for clients) */
  profit_micros: number;
  /** CLIENT: what it was charged */
  spend_micros: number;
  /** delivered / (delivered + failed) in %, null when nothing is final */
  delivery_rate: number | null;
}

function finalRate(delivered: number, failed: number): number | null {
  const final = delivered + failed;
  return final > 0 ? (delivered / final) * 100 : null;
}

/**
 * Align api points to every bucket of the range (missing buckets → 0) so
 * charts never draw a line across a gap. Points outside the range are kept
 * at their own position if they don't match a bucket.
 */
export function fillTimeseries(
  points: TimeseriesPoint[],
  range: Pick<ResolvedRange, "from" | "to" | "granularity">,
): FilledPoint[] {
  const g = range.granularity;
  const byKey = new Map<string, TimeseriesPoint>();
  for (const p of points) {
    // day buckets carry their calendar date in the response timezone (requested as the viewer's)
    const k = g === "day" && p.date ? p.date : pointKey(p.t, g);
    const prev = byKey.get(k);
    byKey.set(
      k,
      prev
        ? {
            t: prev.t,
            messages: prev.messages + p.messages,
            delivered: prev.delivered + p.delivered,
            failed: prev.failed + p.failed,
            revenue_micros: prev.revenue_micros + p.revenue_micros,
            cost_micros: (prev.cost_micros ?? 0) + (p.cost_micros ?? 0),
            spend_micros:
              prev.spend_micros === undefined && p.spend_micros === undefined
                ? undefined
                : (prev.spend_micros ?? 0) + (p.spend_micros ?? 0),
          }
        : p,
    );
  }
  const out: FilledPoint[] = [];
  const used = new Set<string>();
  for (const b of bucketStarts(range)) {
    const k = bucketKey(b, g);
    used.add(k);
    const p = byKey.get(k);
    out.push(toFilled(b.getTime(), p));
  }
  for (const [k, p] of byKey) {
    if (used.has(k)) continue;
    const t = new Date(p.t).getTime();
    if (!Number.isNaN(t)) out.push(toFilled(t, p));
  }
  return out.sort((a, b) => a.t - b.t);
}

function toFilled(t: number, p?: TimeseriesPoint): FilledPoint {
  const messages = p?.messages ?? 0;
  const delivered = p?.delivered ?? 0;
  const failed = p?.failed ?? 0;
  return {
    t,
    messages,
    delivered,
    failed,
    other: Math.max(0, messages - delivered - failed),
    revenue_micros: p?.revenue_micros ?? 0,
    cost_micros: p?.cost_micros ?? 0,
    profit_micros: (p?.revenue_micros ?? 0) - (p?.cost_micros ?? 0),
    spend_micros: p?.spend_micros ?? p?.cost_micros ?? 0,
    delivery_rate: finalRate(delivered, failed),
  };
}

/** Top-N rows by messages, the tail folded into one "Other" row. */
export function topRows(rows: BreakdownRow[], n: number): BreakdownRow[] {
  const sorted = [...rows].sort((a, b) => b.messages - a.messages);
  if (sorted.length <= n) return sorted;
  const head = sorted.slice(0, n - 1);
  const tail = sorted.slice(n - 1);
  const sum = (f: (r: BreakdownRow) => number) => tail.reduce((s, r) => s + f(r), 0);
  const delivered = sum((r) => r.delivered);
  const failed = sum((r) => r.failed);
  const messages = sum((r) => r.messages);
  return [
    ...head,
    {
      key: "__other__",
      label: `Other (${tail.length})`,
      messages,
      delivered,
      failed,
      delivery_rate: messages > 0 ? delivered / messages : 0,
      revenue_micros: sum((r) => r.revenue_micros),
      cost_micros: sum((r) => r.cost_micros),
      ...(tail.some((r) => r.spend_micros !== undefined) ? { spend_micros: sum((r) => r.spend_micros ?? r.cost_micros) } : {}),
    },
  ];
}

/** Display label for a breakdown row (country codes, missing labels). */
export function breakdownLabel(row: BreakdownRow, by: "route" | "country" | "org" | "status"): string {
  if (row.label && row.label.trim()) return row.label;
  if (!row.key) return by === "country" ? "Unknown country" : "Unknown";
  return row.key;
}

/**
 * The money figure a role cares about most: CLIENT → its spend (the api
 * reports it as cost_micros / spend_micros with revenue 0), everyone else →
 * revenue.
 */
export function primaryMoney(
  row: { revenue_micros: number; cost_micros?: number; spend_micros?: number },
  role: OrgRole,
): number {
  if (role === "CLIENT") return row.spend_micros ?? row.cost_micros ?? 0;
  return row.revenue_micros;
}

/** The viewer's IANA timezone (for day buckets that match local calendar days). */
export function viewerTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}
