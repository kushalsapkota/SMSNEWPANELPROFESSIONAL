"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Coins, Hourglass, MessageSquareText, Percent, TrendingUp, Wallet, XCircle } from "lucide-react";
import { useMemo } from "react";
import { ChartCard } from "@/components/charts/chart-card";
import { ChartLegend, ChartTable } from "@/components/charts/chart-parts";
import { HorizontalBars, StackedColumns, TimeLines, barsHeight } from "@/components/charts/charts";
import { Money } from "@/components/shared/money";
import { StatCard } from "@/components/shared/stat-card";
import { StatusBadge, humanize } from "@/components/shared/status-badge";
import { api, qk } from "@/lib/api";
import type { AnalyticsParams, AnalyticsSummary, BreakdownParams, BreakdownRow, OrgRole } from "@/lib/api/types";
import { breakdownLabel, fillTimeseries, type FilledPoint, primaryMoney, topRows, viewerTimeZone } from "@/lib/analytics";
import {
  SERIES,
  STATUS_COLOR,
  compactMoney,
  compactNumber,
  moneyLabels,
  statusColor,
  timeLabel,
} from "@/lib/chart";
import type { ResolvedRange } from "@/lib/date-range";
import { formatMoney } from "@/lib/money";
import { formatNumber, formatPercent } from "@/lib/format";

export type BreakdownBy = BreakdownParams["by"];

export const BREAKDOWN_TITLES: Record<BreakdownBy, string> = {
  route: "Routes",
  country: "Countries",
  org: "Accounts",
  status: "Status",
};

/** Query params for every analytics call from a resolved range + filters. */
export function analyticsParams(r: ResolvedRange, extra: { org_id?: string; route_id?: string } = {}): AnalyticsParams {
  return { from: r.fromIso, to: r.toIso, ...extra };
}

/* --------------------------------------------------------------- summary */

export function useSummary(params: AnalyticsParams) {
  return useQuery({
    queryKey: qk.analytics.summary(params),
    queryFn: () => api.analytics.summary(params),
    placeholderData: keepPreviousData,
  });
}

/** KPI row: volume, outcomes, delivery rate, money (role-correct labels). */
export function SummaryTiles({
  summary,
  loading,
  role,
  currency,
}: {
  summary: AnalyticsSummary | undefined;
  loading: boolean;
  role: OrgRole;
  currency: string;
}) {
  const labels = moneyLabels(role);
  const s = summary;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        title="Messages"
        icon={MessageSquareText}
        loading={loading}
        value={compactNumber(s?.messages)}
        hint={s ? `${formatNumber(s.parts)} parts` : undefined}
      />
      <StatCard
        title="Delivered"
        icon={CheckCircle2}
        loading={loading}
        tone="success"
        value={compactNumber(s?.delivered)}
        hint={s ? `${formatPercent(s.delivery_rate)} delivery rate` : undefined}
      />
      <StatCard
        title="Failed"
        icon={XCircle}
        loading={loading}
        tone={s && s.failed > 0 ? "destructive" : "default"}
        value={compactNumber(s?.failed)}
        hint={s && s.messages ? `${formatPercent(s.failed / s.messages)} of messages` : undefined}
      />
      <StatCard title="Pending" icon={Hourglass} loading={loading} value={compactNumber(s?.pending)} hint="Waiting for a delivery report" />
      <StatCard
        title={labels.revenue}
        icon={role === "CLIENT" ? Wallet : Coins}
        loading={loading}
        value={<Money micros={s ? primaryMoney(s, role) : undefined} currency={currency} decimals={2} />}
        hint={s && s.messages ? `${formatMoney(primaryMoney(s, role) / s.messages, currency, 4)} per message` : undefined}
      />
      {labels.cost ? (
        <StatCard
          title={labels.cost}
          icon={Coins}
          loading={loading}
          value={<Money micros={s?.cost_micros} currency={currency} decimals={2} />}
        />
      ) : null}
      {labels.profit ? (
        <StatCard
          title={labels.profit}
          icon={TrendingUp}
          loading={loading}
          tone={s && s.profit_micros < 0 ? "destructive" : "default"}
          value={<Money micros={s?.profit_micros} currency={currency} decimals={2} />}
          hint={
            s && s.revenue_micros > 0 ? `${((s.profit_micros / s.revenue_micros) * 100).toFixed(1)}% margin` : undefined
          }
        />
      ) : null}
      {role === "CLIENT" ? (
        <StatCard
          title="Delivery rate"
          icon={Percent}
          loading={loading}
          value={formatPercent(s?.delivery_rate)}
          hint="Delivered of all messages"
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ timeseries */

export function useTimeseries(params: AnalyticsParams, granularity: "hour" | "day") {
  // day buckets in the viewer's zone so they line up with the local-midnight range
  const p = { ...params, granularity, tz: granularity === "day" ? viewerTimeZone() : undefined };
  return useQuery({
    queryKey: qk.analytics.timeseries(p),
    queryFn: () => api.analytics.timeseries(p),
    placeholderData: keepPreviousData,
  });
}

const OUTCOME_SERIES = [
  { key: "delivered", label: "Delivered", color: STATUS_COLOR.good },
  { key: "failed", label: "Failed", color: STATUS_COLOR.critical },
  { key: "other", label: "Pending / unknown", color: STATUS_COLOR.neutral },
];

function outcomeTable(points: FilledPoint[], g: "hour" | "day") {
  return (
    <ChartTable
      caption="Messages over time"
      rows={points}
      rowKey={(p) => String(p.t)}
      columns={[
        { header: g === "hour" ? "Hour" : "Day", cell: (p) => timeLabel(p.t, g) },
        { header: "Messages", align: "right", cell: (p) => formatNumber(p.messages) },
        { header: "Delivered", align: "right", cell: (p) => formatNumber(p.delivered) },
        { header: "Failed", align: "right", cell: (p) => formatNumber(p.failed) },
        { header: "Pending", align: "right", cell: (p) => formatNumber(p.other) },
        {
          header: "Delivery rate",
          align: "right",
          cell: (p) => (p.delivery_rate === null ? "—" : `${p.delivery_rate.toFixed(1)}%`),
        },
      ]}
    />
  );
}

/** Messages over time, stacked by outcome. */
export function TrafficCard({
  params,
  range,
  granularity,
  title = "Messages over time",
}: {
  params: AnalyticsParams;
  range: ResolvedRange;
  granularity: "hour" | "day";
  title?: string;
}) {
  const q = useTimeseries(params, granularity);
  const points = useMemo(
    () => fillTimeseries(q.data?.points ?? [], { from: range.from, to: range.to, granularity }),
    [q.data, range.from, range.to, granularity],
  );
  const total = points.reduce((s, p) => s + p.messages, 0);
  return (
    <ChartCard
      title={title}
      description={`Per ${granularity}, by outcome.`}
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      onRetry={() => q.refetch()}
      isEmpty={total === 0}
      legend={<ChartLegend items={OUTCOME_SERIES.map((s) => ({ label: s.label, color: s.color }))} />}
      chart={<StackedColumns data={points} series={OUTCOME_SERIES} granularity={granularity} totalLabel="Messages" />}
      table={outcomeTable(points, granularity)}
    />
  );
}

/** Delivery rate (delivered / final) over time, single series. */
export function DeliveryRateCard({
  params,
  range,
  granularity,
}: {
  params: AnalyticsParams;
  range: ResolvedRange;
  granularity: "hour" | "day";
}) {
  const q = useTimeseries(params, granularity);
  const points = useMemo(
    () => fillTimeseries(q.data?.points ?? [], { from: range.from, to: range.to, granularity }),
    [q.data, range.from, range.to, granularity],
  );
  const any = points.some((p) => p.delivery_rate !== null);
  return (
    <ChartCard
      title="Delivery rate"
      description="Delivered share of messages with a final status."
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      onRetry={() => q.refetch()}
      isEmpty={!any}
      emptyTitle="No final delivery reports in this period"
      chart={
        <TimeLines
          data={points}
          series={[{ key: "delivery_rate", label: "Delivery rate", color: SERIES[1] }]}
          granularity={granularity}
          yDomain={[0, 100]}
          tickFormat={(v) => `${v}%`}
          valueFormat={(v) => `${v.toFixed(1)}%`}
        />
      }
      table={outcomeTable(points, granularity)}
    />
  );
}

/** Money lines per role: CLIENT → spend; others → revenue / cost / profit (categorical slots 1-3). */
export function moneySeries(role: OrgRole) {
  const labels = moneyLabels(role);
  return role === "CLIENT"
    ? [{ key: "spend_micros", label: labels.revenue, color: SERIES[1] }]
    : [
        { key: "revenue_micros", label: labels.revenue, color: SERIES[1] },
        { key: "cost_micros", label: labels.cost ?? "Cost", color: SERIES[2] },
        { key: "profit_micros", label: labels.profit ?? "Profit", color: SERIES[3] },
      ];
}

/**
 * Money over time on one axis: CLIENT → spend; reseller / admin → revenue,
 * cost and profit (slots 1-3, same unit, so one y-scale is honest).
 */
export function MoneyOverTimeCard({
  params,
  range,
  granularity,
  role,
  currency,
}: {
  params: AnalyticsParams;
  range: ResolvedRange;
  granularity: "hour" | "day";
  role: OrgRole;
  currency: string;
}) {
  const q = useTimeseries(params, granularity);
  const points = useMemo(
    () => fillTimeseries(q.data?.points ?? [], { from: range.from, to: range.to, granularity }),
    [q.data, range.from, range.to, granularity],
  );
  const labels = moneyLabels(role);
  const series = moneySeries(role);
  const total = points.reduce((s, p) => s + Number(p[series[0].key] ?? 0), 0);
  const anyMoney = points.some((p) => series.some((sr) => Number(p[sr.key] ?? 0) !== 0));
  return (
    <ChartCard
      title={role === "CLIENT" ? "Spend over time" : "Revenue, cost and profit"}
      description={`${labels.revenue} ${formatMoney(total, currency, 2)} in ${range.label.toLowerCase()}.`}
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      onRetry={() => q.refetch()}
      isEmpty={!anyMoney}
      legend={<ChartLegend items={series.map((sr) => ({ label: sr.label, color: sr.color, shape: "line" as const }))} />}
      chart={
        <TimeLines
          data={points}
          series={series}
          granularity={granularity}
          yDomain={role === "CLIENT" ? [0, "auto"] : ["auto", "auto"]}
          tickFormat={(v) => compactMoney(v, currency)}
          valueFormat={(v) => formatMoney(v, currency, 4)}
        />
      }
      table={
        <ChartTable
          caption="Money over time"
          rows={points}
          rowKey={(p) => String(p.t)}
          columns={[
            { header: granularity === "hour" ? "Hour" : "Day", cell: (p) => timeLabel(p.t, granularity) },
            { header: "Messages", align: "right", cell: (p) => formatNumber(p.messages) },
            ...series.map((sr) => ({
              header: sr.label,
              align: "right" as const,
              cell: (p: FilledPoint) => <Money micros={Number(p[sr.key] ?? 0)} currency={currency} />,
            })),
          ]}
        />
      }
    />
  );
}

/* ------------------------------------------------------------- breakdown */

export function useBreakdown(params: AnalyticsParams, by: BreakdownBy, enabled = true) {
  const p: BreakdownParams = { ...params, by };
  return useQuery({
    queryKey: qk.analytics.breakdown(p),
    queryFn: () => api.analytics.breakdown(p),
    placeholderData: keepPreviousData,
    enabled,
  });
}

function breakdownTable(rows: BreakdownRow[], by: BreakdownBy, role: OrgRole, currency: string) {
  const labels = moneyLabels(role);
  const total = rows.reduce((sum, r) => sum + r.messages, 0);
  type Col = { header: string; align?: "left" | "right"; cell: (r: BreakdownRow) => React.ReactNode };
  const name: Col = {
    header: by === "status" ? "Status" : by === "org" ? "Account" : by === "country" ? "Country" : "Route",
    cell: (r) => (by === "status" ? <StatusBadge status={r.key} label={r.label || undefined} /> : breakdownLabel(r, by)),
  };
  // Money is not attributable per status in the rollups, so the status table shows shares instead.
  const columns: Col[] =
    by === "status"
      ? [
          name,
          { header: "Messages", align: "right", cell: (r) => formatNumber(r.messages) },
          { header: "Share", align: "right", cell: (r) => formatPercent(r.share ?? (total > 0 ? r.messages / total : null)) },
        ]
      : [
          name,
          { header: "Messages", align: "right", cell: (r) => formatNumber(r.messages) },
          { header: "Delivered", align: "right", cell: (r) => formatNumber(r.delivered) },
          { header: "Failed", align: "right", cell: (r) => formatNumber(r.failed) },
          { header: "Rate", align: "right", cell: (r) => formatPercent(r.delivery_rate) },
          { header: labels.revenue, align: "right", cell: (r) => <Money micros={primaryMoney(r, role)} currency={currency} /> },
          ...(labels.cost
            ? [
                { header: labels.cost, align: "right" as const, cell: (r: BreakdownRow) => <Money micros={r.cost_micros} currency={currency} /> },
                {
                  header: labels.profit ?? "Profit",
                  align: "right" as const,
                  cell: (r: BreakdownRow) => (
                    <Money micros={r.profit_micros ?? r.revenue_micros - r.cost_micros} currency={currency} signed />
                  ),
                },
              ]
            : []),
        ];
  return <ChartTable caption={`Breakdown by ${by}`} rows={rows} rowKey={(r) => r.key || r.label} columns={columns} />;
}

/**
 * Ranked bars for one breakdown dimension (top N by messages, tail folded into
 * "Other"), with the full table as the alternate view.
 */
export function BreakdownCard({
  params,
  by,
  role,
  currency,
  title,
  description,
  limit = 8,
  metric = "messages",
}: {
  params: AnalyticsParams;
  by: BreakdownBy;
  role: OrgRole;
  currency: string;
  title?: string;
  description?: string;
  limit?: number;
  /** what the bar length encodes */
  metric?: "messages" | "revenue";
}) {
  const q = useBreakdown(params, by);
  const all = useMemo(() => q.data?.rows ?? [], [q.data]);
  const rows = useMemo(() => {
    if (by === "status") return [...all].sort((a, b) => b.messages - a.messages);
    if (metric === "revenue") {
      return [...all].sort((a, b) => primaryMoney(b, role) - primaryMoney(a, role)).slice(0, limit);
    }
    return topRows(all, limit);
  }, [all, by, limit, metric, role]);
  const labels = moneyLabels(role);
  const valueLabel = metric === "revenue" ? labels.revenue : "Messages";
  const total = all.reduce((sum, r) => sum + r.messages, 0);
  const bars = rows.map((r) => ({
    key: r.key || r.label,
    label: by === "status" ? r.label || humanize(r.key) : breakdownLabel(r, by),
    value: metric === "revenue" ? primaryMoney(r, role) : r.messages,
    color: by === "status" ? statusColor(r.key) : undefined,
    extra: by === "status"
      ? [{ label: "Share", value: formatPercent(r.share ?? (total > 0 ? r.messages / total : null)) }]
      : [
      { label: "Delivered", value: formatNumber(r.delivered) },
      { label: "Failed", value: formatNumber(r.failed) },
      { label: "Delivery rate", value: formatPercent(r.delivery_rate) },
      ...(metric === "messages" ? [{ label: labels.revenue, value: formatMoney(primaryMoney(r, role), currency) }] : []),
    ],
  }));
  return (
    <ChartCard
      title={title ?? `Top ${BREAKDOWN_TITLES[by].toLowerCase()}`}
      description={description ?? (metric === "revenue" ? `By ${labels.revenue.toLowerCase()}.` : "By message volume.")}
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      onRetry={() => q.refetch()}
      isEmpty={total === 0 && all.length === 0}
      height={barsHeight(bars.length)}
      chart={
        <HorizontalBars
          rows={bars}
          color={SERIES[1]}
          valueLabel={valueLabel}
          valueFormat={metric === "revenue" ? (v) => compactMoney(v, currency) : compactNumber}
        />
      }
      table={breakdownTable(all, by, role, currency)}
    />
  );
}
