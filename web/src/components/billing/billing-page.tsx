"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Download, Receipt, Send, Users } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { DataTable, SearchFilter, type Column } from "@/components/data-table";
import { DateRangePicker, useDateRangeParam } from "@/components/analytics/date-range-picker";
import { PageHeader } from "@/components/shared/page-header";
import { Money } from "@/components/shared/money";
import { StatCard } from "@/components/shared/stat-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCurrency } from "@/hooks/use-currency";
import { api, qk } from "@/lib/api";
import type { BillingClientRow } from "@/lib/api/types";
import { useSession } from "@/lib/auth/session";
import { formatNumber, isoDay } from "@/lib/format";
import { formatMoney } from "@/lib/money";

export function BillingPage() {
  const { role } = useSession();
  const currency = useCurrency();
  const search = useSearchParams();
  const { range, resolved, setRange } = useDateRangeParam("7d");
  const [filter, setFilter] = useState<string | undefined>();

  const params = { from: resolved.fromIso, to: resolved.toIso };
  const q = useQuery({
    queryKey: qk.analytics.clients(params),
    queryFn: () => api.analytics.clients(params),
    placeholderData: keepPreviousData,
  });

  const isAdmin = role === "SUPER_ADMIN";
  const noun = isAdmin ? "client / reseller" : "client";

  const rows = useMemo(() => {
    const all = q.data?.rows ?? [];
    if (!filter) return all;
    const f = filter.toLowerCase();
    return all.filter((r) => r.name.toLowerCase().includes(f) || (r.reseller_name ?? "").toLowerCase().includes(f));
  }, [q.data, filter]);

  // Drill-down keeps the chosen date range and opens full Analytics scoped to that client.
  const analyticsHref = (orgId: string) => {
    const p = new URLSearchParams(search.toString());
    p.set("org_id", orgId);
    return `/analytics?${p.toString()}`;
  };

  const totals = q.data?.totals;

  const columns: Column<BillingClientRow>[] = [
    {
      id: "name",
      header: "Client",
      cell: (r) => (
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Link href={analyticsHref(r.org_id)} className="truncate font-medium hover:underline">
              {r.name}
            </Link>
            {r.status && r.status !== "ACTIVE" ? <StatusBadge status={r.status} /> : null}
            {isAdmin && r.role === "RESELLER" ? <Badge variant="outline">reseller</Badge> : null}
          </div>
          {isAdmin && r.reseller_name ? (
            <div className="truncate text-xs text-muted-foreground">via {r.reseller_name}</div>
          ) : null}
        </div>
      ),
    },
    { id: "messages", header: "Sent", align: "right", cell: (r) => formatNumber(r.messages) },
    { id: "parts", header: "Parts", align: "right", hideOnMobile: true, cell: (r) => formatNumber(r.parts) },
    { id: "delivered", header: "Delivered", align: "right", hideOnMobile: true, cell: (r) => formatNumber(r.delivered) },
    { id: "failed", header: "Failed", align: "right", hideOnMobile: true, cell: (r) => formatNumber(r.failed) },
    {
      id: "rate",
      header: "Rate",
      align: "right",
      hideOnMobile: true,
      cell: (r) => `${(r.delivery_rate * 100).toFixed(1)}%`,
    },
    {
      id: "charged",
      header: "Charged",
      align: "right",
      cell: (r) => <Money micros={r.charged_micros} currency={r.currency} decimals={2} />,
    },
    {
      id: "view",
      header: <span className="sr-only">View</span>,
      align: "right",
      cell: (r) => (
        <Button asChild variant="ghost" size="sm">
          <Link href={analyticsHref(r.org_id)}>View</Link>
        </Button>
      ),
    },
  ];

  const exportCsv = () => {
    const head = ["client", "reseller", "status", "sent", "parts", "delivered", "failed", "delivery_rate", "charged", "currency"];
    const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const lines = [head.join(",")];
    for (const r of rows) {
      lines.push(
        [
          r.name,
          r.reseller_name ?? "",
          r.status ?? "",
          r.messages,
          r.parts,
          r.delivered,
          r.failed,
          (r.delivery_rate * 100).toFixed(1) + "%",
          formatMoney(r.charged_micros, r.currency, 4).replace(/[^0-9.-]/g, ""),
          r.currency,
        ]
          .map(esc)
          .join(","),
      );
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `billing_${isoDay(resolved.from)}_${isoDay(resolved.to)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <PageHeader
        title="Billing"
        description={`How many messages each ${noun} sent and the amount charged, for the selected period.`}
      />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
        <DateRangePicker value={range} onChange={setRange} />
        <Button variant="outline" onClick={exportCsv} disabled={rows.length === 0}>
          <Download className="mr-1 h-4 w-4" /> Export CSV
        </Button>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard title={isAdmin ? "Accounts billed" : "Clients billed"} value={formatNumber(totals?.clients ?? 0)} icon={Users} loading={q.isLoading} />
        <StatCard title="Messages sent" value={formatNumber(totals?.messages ?? 0)} icon={Send} loading={q.isLoading} />
        <StatCard
          title="Total charged"
          value={<Money micros={totals?.charged_micros ?? 0} currency={q.data?.currency ?? currency} decimals={2} />}
          icon={Receipt}
          loading={q.isLoading}
        />
      </div>

      <DataTable
        caption="Billing by client"
        columns={columns}
        data={rows}
        rowKey={(r) => r.org_id}
        isLoading={q.isLoading}
        isFetching={q.isFetching}
        error={q.error}
        onRetry={() => q.refetch()}
        empty={{
          title: "No usage in this period",
          description: "Pick a wider date range, or check back once clients start sending.",
        }}
        toolbar={<SearchFilter value={filter} onChange={setFilter} placeholder="Client or reseller name" />}
      />
    </>
  );
}
