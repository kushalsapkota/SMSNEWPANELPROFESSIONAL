/**
 * Chart conventions shared by every chart in the panel.
 *
 * Colors are CSS custom properties defined in app/globals.css (light + .dark
 * steps). Categorical slots 1-3 (blue, orange, aqua) were run through the
 * dataviz palette validator in both modes (adjacent CVD ΔE ≥ 9.2, normal-vision
 * ΔE ≥ 26.5). Slot 3 is below 3:1 on the light surface, so every chart ships
 * with a table view and a legend. Status colors are reserved for message
 * outcomes and always appear next to a text label.
 *
 * Rules: one y-axis per chart, colors follow the entity (never its rank), at
 * most 3 categorical series, thin marks (2px lines, ≤24px bars, 4px rounded
 * data ends), hairline solid grid.
 */
import type { MsgStatus, OrgRole } from "@/lib/api/types";

export const SERIES = {
  1: "var(--chart-1)",
  2: "var(--chart-2)",
  3: "var(--chart-3)",
} as const;

export const STATUS_COLOR = {
  good: "var(--chart-good)",
  warning: "var(--chart-warning)",
  serious: "var(--chart-serious)",
  critical: "var(--chart-critical)",
  neutral: "var(--chart-neutral)",
} as const;

export const CHART = {
  surface: "var(--chart-surface)",
  grid: "var(--chart-grid)",
  axis: "var(--chart-axis)",
  ink: "var(--chart-ink-muted)",
  barSize: 20,
  tick: { fontSize: 11, fill: "var(--chart-ink-muted)" },
} as const;

/** Message status → reserved status color (outcome semantics, not identity). */
export function statusColor(status: string): string {
  switch (status as MsgStatus) {
    case "DELIVERED":
      return STATUS_COLOR.good;
    case "UNDELIVERED":
    case "EXPIRED":
      return STATUS_COLOR.serious;
    case "FAILED":
    case "REJECTED":
      return STATUS_COLOR.critical;
    default:
      // ACCEPTED / QUEUED / SUBMITTED (in flight) and UNKNOWN
      return STATUS_COLOR.neutral;
  }
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const plain = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** 0 / 950 / 1.2K / 3.4M for axis ticks and stat tiles. */
export function compactNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Math.abs(n) >= 1000 ? compact.format(n) : plain.format(n);
}

/** Compact money from micros for axis ticks ($1.2K). Full precision lives in tooltips/tables. */
export function compactMoney(micros: number, currency = "USD"): string {
  const v = micros / 1_000_000;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      notation: Math.abs(v) >= 1000 ? "compact" : "standard",
      maximumFractionDigits: Math.abs(v) >= 1 ? 1 : 3,
    }).format(v);
  } catch {
    return compactNumber(v);
  }
}

const hourFmt = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const fullHourFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const fullDayFmt = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });

/** Axis tick for a bucket start (epoch ms). */
export function timeTick(ms: number, granularity: "hour" | "day"): string {
  return granularity === "hour" ? hourFmt.format(ms) : dayFmt.format(ms);
}

/** Tooltip / table heading for a bucket start. */
export function timeLabel(ms: number, granularity: "hour" | "day"): string {
  return granularity === "hour" ? fullHourFmt.format(ms) : fullDayFmt.format(ms);
}

/** 0..1 or 0..100 → 0..100 */
export function toPct(rate: number | null | undefined): number | null {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return null;
  return rate <= 1 ? rate * 100 : rate;
}

/**
 * Money labels per acting role (analytics `revenue/cost/profit_micros` are
 * computed from the viewer's side of the bill):
 *   CLIENT      revenue = what it was charged → "Spend"; no cost / profit.
 *   RESELLER    revenue = its clients' charges, cost = its wholesale charges.
 *   SUPER_ADMIN revenue = resellers' charges, cost = upstream route cost.
 */
export function moneyLabels(role: OrgRole): { revenue: string; cost: string | null; profit: string | null } {
  if (role === "CLIENT") return { revenue: "Spend", cost: null, profit: null };
  if (role === "RESELLER") return { revenue: "Revenue", cost: "Wholesale cost", profit: "Profit" };
  return { revenue: "Revenue", cost: "Upstream cost", profit: "Profit" };
}

/** Short description of the money labels for card subtitles. */
export function moneyDescription(role: OrgRole): string {
  if (role === "CLIENT") return "What your messages cost.";
  if (role === "RESELLER") return "Charged to your clients vs. what you pay for the same traffic.";
  return "Charged to resellers vs. upstream route cost.";
}
