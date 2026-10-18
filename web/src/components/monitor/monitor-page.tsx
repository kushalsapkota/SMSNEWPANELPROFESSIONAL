"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, Gauge, Layers, Network, Pause, Play, Radio } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChartCard } from "@/components/charts/chart-card";
import { ChartLegend, ChartTable } from "@/components/charts/chart-parts";
import { TimeLines } from "@/components/charts/charts";
import { DataTable, SearchFilter, type Column } from "@/components/data-table";
import { PageHeader } from "@/components/shared/page-header";
import { StatCard } from "@/components/shared/stat-card";
import { EmptyState, ErrorState, LoadingState } from "@/components/shared/states";
import { StatusBadge } from "@/components/shared/status-badge";
import { api, qk } from "@/lib/api";
import type { ConnectionStatus, SmppSession } from "@/lib/api/types";
import { useSession } from "@/lib/auth/session";
import { SERIES, compactNumber } from "@/lib/chart";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

const POLL_MS = 3000;
/** live window: 5 minutes of 3-second samples */
const WINDOW = 100;

const secFmt = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

interface SampleValues {
  tps_in: number | null;
  tps_out: number | null;
  queue: number | null;
}

interface Sample extends SampleValues {
  [k: string]: number | null;
  t: number;
}

/** Rolling buffer of live samples, appended whenever a poll returns. */
function useSamples(sample: SampleValues | null, stamp: number) {
  const [samples, setSamples] = useState<Sample[]>([]);
  const last = useRef(0);
  useEffect(() => {
    if (!sample || !stamp || stamp === last.current) return;
    last.current = stamp;
    setSamples((prev) => [...prev.slice(-(WINDOW - 1)), { t: stamp, ...sample }]);
    // sample is derived from the same response as stamp
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp]);
  return samples;
}

function sessionDot(state: string) {
  return state === "BOUND_TRX" || state.startsWith("BOUND")
    ? "bg-success"
    : state === "CONNECTING"
      ? "bg-warning animate-pulse"
      : "bg-destructive";
}

function ConnectionTile({ c }: { c: ConnectionStatus }) {
  const load = c.tps_limit > 0 ? Math.min(100, (c.tps_current / c.tps_limit) * 100) : 0;
  const bound = c.sessions.filter((s) => s.state.startsWith("BOUND")).length;
  const lastError = c.sessions.find((s) => s.last_error)?.last_error;
  return (
    <Card className={cn(!c.enabled && "opacity-70")}>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 pb-3">
        <div className="min-w-0">
          <CardTitle className="truncate text-base">{c.name}</CardTitle>
          <CardDescription>
            {bound}/{c.sessions.length} sessions bound
          </CardDescription>
        </div>
        <StatusBadge status={c.state} />
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-1.5" aria-label="Sessions">
          {c.sessions.map((s) => (
            <Tooltip key={s.index}>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  className={cn("inline-block h-3 w-3 rounded-full ring-2 ring-background", sessionDot(s.state))}
                  aria-label={`Session ${s.index}: ${s.state}`}
                />
              </TooltipTrigger>
              <TooltipContent>
                <p className="font-medium">
                  Session {s.index}: {s.state}
                </p>
                {s.bound_since ? <p>Bound {formatRelative(s.bound_since)}</p> : null}
                {s.last_error ? <p className="max-w-xs">{s.last_error}</p> : null}
              </TooltipContent>
            </Tooltip>
          ))}
          {c.sessions.length === 0 ? <span className="text-xs text-muted-foreground">No sessions</span> : null}
        </div>
        <div className="space-y-1">
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">TPS</span>
            <span className="tabular-nums">
              {c.tps_current.toFixed(1)} / {formatNumber(c.tps_limit)}
            </span>
          </div>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--chart-1)_20%,transparent)]"
            role="meter"
            aria-label={`${c.name} TPS load`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(load)}
          >
            <div
              className={cn("h-full rounded-full", load >= 95 ? "bg-destructive" : load >= 80 ? "bg-warning" : "bg-[var(--chart-1)]")}
              style={{ width: `${load}%` }}
            />
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <dt className="text-muted-foreground">Queue</dt>
            <dd className={cn("text-sm font-medium tabular-nums", c.queue_depth > 1000 && "text-warning")}>{compactNumber(c.queue_depth)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">In flight</dt>
            <dd className="text-sm font-medium tabular-nums">{formatNumber(c.inflight)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Submitted</dt>
            <dd className="text-sm tabular-nums">{compactNumber(c.submitted_total)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Failed</dt>
            <dd className={cn("text-sm tabular-nums", c.failed_total > 0 && "text-destructive")}>{compactNumber(c.failed_total)}</dd>
          </div>
        </dl>
        {lastError ? (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="break-words">{lastError}</span>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SessionsTable({ sessions, isLoading, error, onRetry, role }: {
  sessions: SmppSession[] | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  role: string;
}) {
  const [filter, setFilter] = useState<string | undefined>();
  const rows = useMemo(() => {
    const all = sessions ?? [];
    if (!filter) return all;
    const f = filter.toLowerCase();
    return all.filter((s) => s.system_id.toLowerCase().includes(f) || (s.org_name ?? "").toLowerCase().includes(f) || s.remote_addr.includes(f));
  }, [sessions, filter]);
  const columns: Column<SmppSession>[] = [
    { id: "system_id", header: "System ID", cell: (s) => <span className="font-mono text-sm">{s.system_id}</span> },
    ...(role !== "CLIENT" ? [{ id: "org", header: "Account", cell: (s: SmppSession) => s.org_name ?? s.org_id.slice(0, 8) }] : []),
    { id: "bind", header: "Bind", cell: (s) => <Badge variant="outline">{s.bind_type}</Badge> },
    { id: "remote", header: "Remote", hideOnMobile: true, cell: (s) => <span className="font-mono text-xs">{s.remote_addr}</span> },
    { id: "since", header: "Bound since", hideOnMobile: true, cell: (s) => <span title={formatDateTime(s.bound_since)}>{formatRelative(s.bound_since)}</span> },
    { id: "tps", header: "TPS", align: "right", cell: (s) => s.tps_current.toFixed(1) },
    { id: "total", header: "Submitted", align: "right", hideOnMobile: true, cell: (s) => formatNumber(s.submitted_total) },
  ];
  return (
    <DataTable
      caption="Client SMPP sessions"
      columns={columns}
      data={rows}
      rowKey={(s) => s.session_id}
      isLoading={isLoading}
      error={error}
      onRetry={onRetry}
      empty={{ title: "No SMPP clients bound", description: "Sessions appear here as soon as a client binds on port 2775." }}
      toolbar={<SearchFilter value={filter} onChange={setFilter} placeholder="System ID, account or IP" />}
    />
  );
}

export function MonitorPage() {
  const { role } = useSession();
  const admin = role === "SUPER_ADMIN";
  const [paused, setPaused] = useState(false);
  const interval = paused ? false : POLL_MS;

  const conns = useQuery({
    queryKey: qk.monitor.connections,
    queryFn: api.monitor.connections,
    enabled: admin,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });
  const sessions = useQuery({
    queryKey: qk.monitor.smppSessions,
    queryFn: api.monitor.smppSessions,
    refetchInterval: interval,
  });
  const live = useQuery({
    queryKey: qk.analytics.live,
    queryFn: api.analytics.live,
    enabled: admin,
    refetchInterval: interval,
    retry: false,
  });

  const sessionTps = (sessions.data?.sessions ?? []).reduce((s, x) => s + x.tps_current, 0);
  const connList = conns.data?.connections ?? [];
  const derivedQueue = connList.reduce((s, c) => s + c.queue_depth, 0);
  const derivedOut = connList.reduce((s, c) => s + c.tps_current, 0);

  // Admin: engine live metrics (fallback: sums over connections). Reseller: its clients' SMPP TPS.
  const sample: SampleValues | null = admin
    ? live.data
      ? { tps_in: live.data.tps_in, tps_out: live.data.tps_out, queue: live.data.queue_depth }
      : conns.data
        ? { tps_in: null, tps_out: derivedOut, queue: derivedQueue }
        : null
    : sessions.data
      ? { tps_in: sessionTps, tps_out: null, queue: null }
      : null;
  const stamp = admin ? (live.data ? live.dataUpdatedAt : conns.dataUpdatedAt) : sessions.dataUpdatedAt;
  const samples = useSamples(sample, stamp);

  const up = live.data?.connections_up ?? connList.filter((c) => c.state === "BOUND").length;
  const total = live.data?.connections_total ?? connList.length;
  const series = admin
    ? [
        { key: "tps_in", label: "TPS in (accepted)", color: SERIES[1] },
        { key: "tps_out", label: "TPS out (submitted)", color: SERIES[2] },
      ]
    : [{ key: "tps_in", label: "Client SMPP TPS", color: SERIES[1] }];
  const lastUpdate = Math.max(conns.dataUpdatedAt, sessions.dataUpdatedAt, live.dataUpdatedAt);

  return (
    <>
      <PageHeader
        title="Monitor"
        description={admin ? "Upstream SMPP connections, client sessions and live throughput." : "Your clients' SMPP sessions and live throughput."}
        actions={
          <>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
              <Radio className={cn("h-3.5 w-3.5", !paused && "animate-pulse text-success")} aria-hidden />
              {paused ? "Paused" : `Live · every ${POLL_MS / 1000}s`}
              {lastUpdate ? ` · ${secFmt.format(lastUpdate)}` : ""}
            </span>
            <Button variant="outline" size="sm" onClick={() => setPaused((p) => !p)}>
              {paused ? <Play aria-hidden /> : <Pause aria-hidden />}
              {paused ? "Resume" : "Pause"}
            </Button>
          </>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {admin ? (
          <>
            <StatCard
              title="Connections up"
              icon={Network}
              loading={conns.isLoading && live.isLoading}
              tone={total > 0 && up < total ? "warning" : "success"}
              value={`${up} / ${total}`}
            />
            <StatCard
              title="TPS in"
              icon={Activity}
              loading={live.isLoading && conns.isLoading}
              value={sample?.tps_in !== null && sample?.tps_in !== undefined ? sample.tps_in.toFixed(1) : "—"}
              hint="Accepted by the gateway"
            />
            <StatCard
              title="TPS out"
              icon={Gauge}
              loading={live.isLoading && conns.isLoading}
              value={sample?.tps_out !== null && sample?.tps_out !== undefined ? sample.tps_out.toFixed(1) : "—"}
              hint="Submitted upstream"
            />
            <StatCard
              title="Queue depth"
              icon={Layers}
              loading={live.isLoading && conns.isLoading}
              tone={(sample?.queue ?? 0) > 1000 ? "warning" : "default"}
              value={compactNumber(sample?.queue)}
            />
          </>
        ) : (
          <>
            <StatCard title="Bound sessions" icon={Network} loading={sessions.isLoading} value={formatNumber(sessions.data?.sessions.length)} />
            <StatCard title="Client TPS" icon={Activity} loading={sessions.isLoading} value={sessionTps.toFixed(1)} hint="Sum over bound SMPP sessions" />
            <StatCard
              title="Accounts online"
              icon={Gauge}
              loading={sessions.isLoading}
              value={formatNumber(new Set((sessions.data?.sessions ?? []).map((s) => s.org_id)).size)}
            />
          </>
        )}
      </div>

      <div className="mb-6">
        <ChartCard
          title="Live throughput"
          description="Last 5 minutes, messages per second."
          isLoading={samples.length === 0 && (admin ? live.isLoading && conns.isLoading : sessions.isLoading)}
          isEmpty={samples.length === 0}
          emptyTitle="Waiting for the first sample…"
          height={220}
          legend={<ChartLegend items={series.map((s) => ({ label: s.label, color: s.color, shape: "line" as const }))} />}
          chart={
            <TimeLines
              data={samples}
              series={series}
              granularity="hour"
              valueFormat={(v) => `${v.toFixed(1)} msg/s`}
              tickFormat={(v) => compactNumber(v)}
              timeFormat={{ tick: (ms) => secFmt.format(ms), label: (ms) => secFmt.format(ms) }}
            />
          }
          table={
            <ChartTable
              caption="Live throughput samples"
              rows={[...samples].reverse()}
              rowKey={(s) => String(s.t)}
              columns={[
                { header: "Time", cell: (s) => secFmt.format(s.t) },
                ...series.map((sr) => ({
                  header: sr.label,
                  align: "right" as const,
                  cell: (s: Sample) => (s[sr.key] === null || s[sr.key] === undefined ? "—" : Number(s[sr.key]).toFixed(1)),
                })),
                ...(admin ? [{ header: "Queue", align: "right" as const, cell: (s: Sample) => compactNumber(s.queue) }] : []),
              ]}
            />
          }
        />
      </div>

      {admin ? (
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold tracking-tight">Upstream connections</h2>
          {conns.isLoading ? (
            <LoadingState rows={3} />
          ) : conns.isError ? (
            <Card>
              <ErrorState error={conns.error} onRetry={() => conns.refetch()} title="Engine status unavailable" />
            </Card>
          ) : connList.length === 0 ? (
            <Card>
              <EmptyState title="No upstream connections" description="Add one under Connections." />
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {[...connList]
                .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name))
                .map((c) => (
                  <ConnectionTile key={c.connection_id} c={c} />
                ))}
            </div>
          )}
        </section>
      ) : null}

      <section>
        <h2 className="mb-3 text-lg font-semibold tracking-tight">Client SMPP sessions</h2>
        <SessionsTable
          sessions={sessions.data?.sessions}
          isLoading={sessions.isLoading}
          error={sessions.error}
          onRetry={() => sessions.refetch()}
          role={role}
        />
      </section>
    </>
  );
}
