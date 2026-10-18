"use client";

import type { ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART, compactNumber, timeLabel, timeTick } from "@/lib/chart";
import { TooltipBox } from "./chart-parts";

/* Recharts' tooltip payload, narrowed to what our content renderers read. */
interface TipPayload {
  dataKey?: string | number;
  value?: number | string;
  payload?: Record<string, unknown>;
}
interface TipProps {
  active?: boolean;
  label?: number | string;
  payload?: TipPayload[];
}

export interface SeriesDef {
  key: string;
  label: string;
  color: string;
}

const axisProps = {
  stroke: CHART.axis,
  tick: CHART.tick,
  tickLine: false,
} as const;

/* ------------------------------------------------------------ stacked columns */

/**
 * Stacked columns over time (part-to-whole per bucket). Bucket start is `t`
 * (epoch ms). Segments are separated by a 2px surface gap; only the top
 * segment carries the 4px rounded data-end.
 */
export function StackedColumns({
  data,
  series,
  granularity,
  valueFormat = compactNumber,
  totalLabel = "Total",
}: {
  data: Array<{ t: number } & Record<string, number | null>>;
  series: SeriesDef[];
  granularity: "hour" | "day";
  valueFormat?: (n: number) => ReactNode;
  totalLabel?: string;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="20%">
        <CartesianGrid vertical={false} stroke={CHART.grid} />
        <XAxis
          dataKey="t"
          {...axisProps}
          tickFormatter={(v: number) => timeTick(v, granularity)}
          minTickGap={16}
        />
        <YAxis {...axisProps} axisLine={false} width={44} allowDecimals={false} tickFormatter={(v: number) => compactNumber(v)} />
        <Tooltip
          cursor={{ fill: "hsl(var(--muted))", opacity: 0.6 }}
          content={(p: TipProps) => {
            if (!p.active || !p.payload?.length) return null;
            const row = p.payload[0].payload ?? {};
            const total = series.reduce((s, d) => s + Number(row[d.key] ?? 0), 0);
            return (
              <TooltipBox
                title={timeLabel(Number(p.label), granularity)}
                rows={[
                  { label: totalLabel, value: valueFormat(total) },
                  ...[...series].reverse().map((s) => ({
                    label: s.label,
                    value: valueFormat(Number(row[s.key] ?? 0)),
                    color: s.color,
                  })),
                ]}
              />
            );
          }}
        />
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            stackId="a"
            fill={s.color}
            stroke={CHART.surface}
            strokeWidth={2}
            maxBarSize={24}
            radius={i === series.length - 1 ? [4, 4, 0, 0] : 0}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ------------------------------------------------------------------ lines */

/**
 * One or more lines over time on ONE y-axis. 2px lines, end dot on the last
 * point, crosshair tooltip listing every series at that x.
 */
export function TimeLines({
  data,
  series,
  granularity,
  valueFormat = compactNumber,
  tickFormat = compactNumber,
  yDomain,
  timeFormat,
}: {
  data: Array<{ t: number } & Record<string, number | null>>;
  series: SeriesDef[];
  granularity: "hour" | "day";
  valueFormat?: (n: number) => ReactNode;
  tickFormat?: (n: number) => string;
  yDomain?: [number | "auto", number | "auto"];
  /** override tick/label formatting (e.g. seconds for live charts) */
  timeFormat?: { tick: (ms: number) => string; label: (ms: number) => string };
}) {
  const last = data.length - 1;
  const tick = timeFormat?.tick ?? ((v: number) => timeTick(v, granularity));
  const label = timeFormat?.label ?? ((v: number) => timeLabel(v, granularity));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={CHART.grid} />
        <XAxis dataKey="t" {...axisProps} tickFormatter={tick} minTickGap={24} />
        <YAxis
          {...axisProps}
          axisLine={false}
          width={52}
          domain={yDomain ?? [0, "auto"]}
          tickFormatter={(v: number) => tickFormat(v)}
        />
        <Tooltip
          cursor={{ stroke: CHART.axis, strokeWidth: 1 }}
          content={(p: TipProps) => {
            if (!p.active || !p.payload?.length) return null;
            const row = p.payload[0].payload ?? {};
            return (
              <TooltipBox
                title={label(Number(p.label))}
                rows={series.map((s) => {
                  const v = row[s.key];
                  return {
                    label: s.label,
                    value: v === null || v === undefined ? "—" : valueFormat(Number(v)),
                    color: s.color,
                  };
                })}
              />
            );
          }}
        />
        {series.map((s) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stroke={s.color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            connectNulls={false}
            isAnimationActive={false}
            activeDot={{ r: 4, fill: s.color, stroke: CHART.surface, strokeWidth: 2 }}
            dot={(props: { cx?: number; cy?: number; index?: number; value?: number | null }) => {
              if (props.index !== last || props.value === null || props.value === undefined || props.cx === undefined || props.cy === undefined) {
                return <g key={`${s.key}-${props.index}`} />;
              }
              return (
                <circle
                  key={`${s.key}-end`}
                  cx={props.cx}
                  cy={props.cy}
                  r={4}
                  fill={s.color}
                  stroke={CHART.surface}
                  strokeWidth={2}
                />
              );
            }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

/* --------------------------------------------------------- horizontal bars */

export interface BarRow {
  key: string;
  label: string;
  value: number;
  color?: string;
  /** extra tooltip rows */
  extra?: Array<{ label: string; value: ReactNode }>;
}

/**
 * Ranked horizontal bars (top routes / countries / clients / statuses). One
 * color unless rows carry their own (status semantics). Value at the bar tip;
 * category labels on the axis in text ink.
 */
export function HorizontalBars({
  rows,
  color,
  valueFormat = compactNumber,
  valueLabel,
  labelWidth = 120,
}: {
  rows: BarRow[];
  color: string;
  valueFormat?: (n: number) => string;
  valueLabel: string;
  labelWidth?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 56, bottom: 0, left: 0 }} barCategoryGap={6}>
        <XAxis type="number" hide domain={[0, "dataMax"]} />
        <YAxis
          type="category"
          dataKey="label"
          width={labelWidth}
          tickLine={false}
          axisLine={{ stroke: CHART.axis }}
          tick={{ fontSize: 12, fill: "hsl(var(--foreground))" }}
          tickFormatter={(v: string) => (v.length > 18 ? `${v.slice(0, 17)}…` : v)}
          interval={0}
        />
        <Tooltip
          cursor={{ fill: "hsl(var(--muted))", opacity: 0.6 }}
          content={(p: TipProps) => {
            if (!p.active || !p.payload?.length) return null;
            const row = p.payload[0].payload as unknown as BarRow;
            return (
              <TooltipBox
                title={row.label}
                rows={[
                  { label: valueLabel, value: valueFormat(row.value), color: row.color ?? color },
                  ...(row.extra ?? []),
                ]}
              />
            );
          }}
        />
        <Bar dataKey="value" name={valueLabel} maxBarSize={20} radius={[0, 4, 4, 0]} isAnimationActive={false}>
          {rows.map((r) => (
            <Cell key={r.key} fill={r.color ?? color} />
          ))}
          <LabelList
            dataKey="value"
            position="right"
            formatter={(v: number) => valueFormat(v)}
            style={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Height for a horizontal bar chart with n rows (row band + padding). */
export function barsHeight(n: number): number {
  return Math.max(120, n * 32 + 16);
}
