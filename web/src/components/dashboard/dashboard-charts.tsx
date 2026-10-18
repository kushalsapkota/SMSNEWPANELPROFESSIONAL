"use client";

import { useMemo } from "react";
import { ChartCard } from "@/components/charts/chart-card";
import { ChartLegend, ChartTable } from "@/components/charts/chart-parts";
import { StackedColumns, TimeLines } from "@/components/charts/charts";
import { BreakdownCard, analyticsParams, moneySeries, SummaryTiles, useSummary } from "@/components/analytics/widgets";
import { Money } from "@/components/shared/money";
import { useCurrency } from "@/hooks/use-currency";
import { type FilledPoint, fillTimeseries } from "@/lib/analytics";
import type { DashboardDay, OrgRole } from "@/lib/api/types";
import { STATUS_COLOR, compactMoney, moneyDescription, moneyLabels, timeLabel } from "@/lib/chart";
import { resolveRange } from "@/lib/date-range";
import { formatMoney } from "@/lib/money";
import { formatNumber } from "@/lib/format";

const OUTCOMES = [
  { key: "delivered", label: "Delivered", color: STATUS_COLOR.good },
  { key: "failed", label: "Failed", color: STATUS_COLOR.critical },
  { key: "other", label: "Pending / unknown", color: STATUS_COLOR.neutral },
];

/**
 * Charts below the dashboard cards: 7-day traffic (from GET /api/dashboard),
 * then 30-day money tiles, status distribution and top routes / countries /
 * clients from the analytics endpoints.
 */
export function DashboardCharts({
  role,
  last7d,
  loading,
  fetching,
}: {
  role: OrgRole;
  last7d: DashboardDay[] | undefined;
  loading: boolean;
  fetching: boolean;
}) {
  const currency = useCurrency();
  const minute = Math.floor(Date.now() / 600_000);
  const week = useMemo(() => resolveRange({ preset: "7d" }, new Date(minute * 600_000)), [minute]);
  const month = useMemo(() => resolveRange({ preset: "30d" }, new Date(minute * 600_000)), [minute]);
  const points = useMemo(
    () =>
      fillTimeseries(
        (last7d ?? []).map((d) => ({
          t: d.date,
          date: d.date,
          messages: d.messages,
          delivered: d.delivered,
          failed: d.failed,
          revenue_micros: d.revenue_micros ?? 0,
          cost_micros: d.cost_micros,
          spend_micros: d.spend_micros,
        })),
        week,
      ),
    [last7d, week],
  );
  const hasRevenue = (last7d ?? []).some((d) => d.revenue_micros !== undefined || d.spend_micros !== undefined);
  const series = moneySeries(role);
  const params = analyticsParams(month);
  const summary = useSummary(params);
  const labels = moneyLabels(role);
  const total = points.reduce((s, p) => s + p.messages, 0);

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard
          title="Messages, last 7 days"
          description="Daily volume by outcome."
          isLoading={loading}
          isFetching={fetching}
          isEmpty={total === 0}
          legend={<ChartLegend items={OUTCOMES.map((o) => ({ label: o.label, color: o.color }))} />}
          chart={<StackedColumns data={points} series={OUTCOMES} granularity="day" totalLabel="Messages" />}
          table={
            <ChartTable
              caption="Messages, last 7 days"
              rows={points}
              rowKey={(p) => String(p.t)}
              columns={[
                { header: "Day", cell: (p) => timeLabel(p.t, "day") },
                { header: "Messages", align: "right", cell: (p) => formatNumber(p.messages) },
                { header: "Delivered", align: "right", cell: (p) => formatNumber(p.delivered) },
                { header: "Failed", align: "right", cell: (p) => formatNumber(p.failed) },
              ]}
            />
          }
        />
        {hasRevenue ? (
          <ChartCard
            title={role === "CLIENT" ? "Spend, last 7 days" : "Revenue, cost and profit, last 7 days"}
            description={`${labels.revenue} ${formatMoney(points.reduce((s, p) => s + Number(p[series[0].key] ?? 0), 0), currency, 2)}.`}
            isLoading={loading}
            isFetching={fetching}
            isEmpty={points.every((p) => series.every((sr) => Number(p[sr.key] ?? 0) === 0))}
            legend={<ChartLegend items={series.map((sr) => ({ label: sr.label, color: sr.color, shape: "line" as const }))} />}
            chart={
              <TimeLines
                data={points}
                series={series}
                yDomain={role === "CLIENT" ? [0, "auto"] : ["auto", "auto"]}
                granularity="day"
                tickFormat={(v) => compactMoney(v, currency)}
                valueFormat={(v) => formatMoney(v, currency, 4)}
              />
            }
            table={
              <ChartTable
                caption={`${labels.revenue}, last 7 days`}
                rows={points}
                rowKey={(p) => String(p.t)}
                columns={[
                  { header: "Day", cell: (p) => timeLabel(p.t, "day") },
                  ...series.map((sr) => ({
                    header: sr.label,
                    align: "right" as const,
                    cell: (p: FilledPoint) => <Money micros={Number(p[sr.key] ?? 0)} currency={currency} />,
                  })),
                ]}
              />
            }
          />
        ) : (
          <BreakdownCard
            params={params}
            by="status"
            role={role}
            currency={currency}
            title="Status distribution, last 30 days"
            description="Current status of messages."
          />
        )}
      </div>

      <div>
        <h2 className="mb-1 text-lg font-semibold tracking-tight">Last 30 days</h2>
        <p className="mb-3 text-sm text-muted-foreground">{moneyDescription(role)}</p>
        <SummaryTiles summary={summary.data} loading={summary.isLoading} role={role} currency={currency} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {hasRevenue ? (
          <BreakdownCard
            params={params}
            by="status"
            role={role}
            currency={currency}
            title="Status distribution"
            description="Current status of messages, last 30 days."
          />
        ) : null}
        <BreakdownCard params={params} by="route" role={role} currency={currency} limit={6} title="Top routes" />
        <BreakdownCard params={params} by="country" role={role} currency={currency} limit={6} title="Top countries" />
        {role !== "CLIENT" ? (
          <BreakdownCard
            params={params}
            by="org"
            role={role}
            currency={currency}
            limit={6}
            metric="revenue"
            title={role === "SUPER_ADMIN" ? "Top resellers" : "Top clients"}
            description={`By ${labels.revenue.toLowerCase()}, last 30 days.`}
          />
        ) : null}
      </div>
    </div>
  );
}
