"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Building2,
  CheckCircle2,
  MessageSquareText,
  Network,
  Route as RouteIcon,
  Users,
  Wallet,
  XCircle,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/data-table";
import { Money } from "@/components/shared/money";
import { PageHeader } from "@/components/shared/page-header";
import { StatCard } from "@/components/shared/stat-card";
import { ErrorState } from "@/components/shared/states";
import { DashboardCharts } from "@/components/dashboard/dashboard-charts";
import { api, qk } from "@/lib/api";
import type { DashboardDay } from "@/lib/api/types";
import { useSession } from "@/lib/auth/session";
import { formatDate, formatNumber, formatPercent } from "@/lib/format";

const dayColumns: Column<DashboardDay>[] = [
  { id: "date", header: "Day", cell: (d) => formatDate(d.date) },
  { id: "messages", header: "Messages", align: "right", cell: (d) => formatNumber(d.messages) },
  { id: "delivered", header: "Delivered", align: "right", cell: (d) => formatNumber(d.delivered) },
  { id: "failed", header: "Failed", align: "right", cell: (d) => formatNumber(d.failed) },
  {
    id: "rate",
    header: "Delivery rate",
    align: "right",
    hideOnMobile: true,
    cell: (d) => (d.messages ? formatPercent(d.delivered / d.messages) : "—"),
  },
];

export function DashboardView() {
  const { role, org, user } = useSession();
  const q = useQuery({ queryKey: qk.dashboard, queryFn: api.dashboard.get, refetchInterval: 60_000 });
  const d = q.data;
  const loading = q.isLoading;
  const deliveryRate = d && d.today.messages ? d.today.delivered / d.today.messages : null;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`Welcome back${user.full_name ? `, ${user.full_name}` : ""} — ${org.name}`}
      />
      {q.isError ? (
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {role !== "SUPER_ADMIN" ? (
              <StatCard
                title="Balance"
                icon={Wallet}
                loading={loading}
                value={
                  d?.balance ? (
                    <Money micros={d.balance.balance_micros} currency={d.balance.currency} decimals={2} />
                  ) : (
                    "—"
                  )
                }
                hint={
                  d?.balance?.billing_mode === "POSTPAID" ? (
                    <>
                      Postpaid · credit limit{" "}
                      <Money micros={d.balance.credit_limit_micros} currency={d.balance.currency} decimals={2} />
                    </>
                  ) : (
                    "Prepaid"
                  )
                }
              />
            ) : null}
            <StatCard
              title="Messages today"
              icon={MessageSquareText}
              loading={loading}
              value={formatNumber(d?.today.messages)}
            />
            <StatCard
              title="Delivered today"
              icon={CheckCircle2}
              loading={loading}
              tone="success"
              value={formatNumber(d?.today.delivered)}
              hint={deliveryRate !== null ? `${formatPercent(deliveryRate)} delivery rate` : undefined}
            />
            <StatCard
              title="Failed today"
              icon={XCircle}
              loading={loading}
              tone={d && d.today.failed > 0 ? "destructive" : "default"}
              value={formatNumber(d?.today.failed)}
            />
            {d?.counts.resellers !== undefined ? (
              <StatCard title="Resellers" icon={Building2} value={formatNumber(d.counts.resellers)} />
            ) : null}
            {d?.counts.clients !== undefined ? (
              <StatCard title="Clients" icon={Users} value={formatNumber(d.counts.clients)} />
            ) : null}
            {d?.counts.routes !== undefined ? (
              <StatCard title="Routes" icon={RouteIcon} value={formatNumber(d.counts.routes)} />
            ) : null}
            {d?.counts.connections_up !== undefined && d.counts.connections_up !== null ? (
              <StatCard
                title="Connections up"
                icon={Network}
                tone={
                  d.counts.connections_total !== undefined &&
                  d.counts.connections_total !== null &&
                  d.counts.connections_up < d.counts.connections_total
                    ? "warning"
                    : "success"
                }
                value={
                  d.counts.connections_total !== undefined && d.counts.connections_total !== null
                    ? `${d.counts.connections_up} / ${d.counts.connections_total}`
                    : formatNumber(d.counts.connections_up)
                }
              />
            ) : null}
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Last 7 days</CardTitle>
              <CardDescription>Daily message volume and outcomes.</CardDescription>
            </CardHeader>
            <CardContent>
              <DataTable
                columns={dayColumns}
                data={d?.last7d}
                isLoading={loading}
                rowKey={(r) => r.date}
                empty={{ title: "No traffic in the last 7 days" }}
              />
            </CardContent>
          </Card>

          <DashboardCharts role={role} last7d={d?.last7d} loading={loading} fetching={q.isFetching} />
        </div>
      )}
    </>
  );
}
