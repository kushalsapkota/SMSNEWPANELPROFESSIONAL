"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Download, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, ResetFiltersButton, SearchFilter, SelectFilter, type Column } from "@/components/data-table";
import { DateRangePicker, useDateRangeParam } from "@/components/analytics/date-range-picker";
import { Money } from "@/components/shared/money";
import { PageHeader } from "@/components/shared/page-header";
import { StatusBadge } from "@/components/shared/status-badge";
import { useChildOrgOptions } from "@/hooks/use-child-orgs";
import { useCurrency } from "@/hooks/use-currency";
import { useRouteOptions } from "@/hooks/use-route-options";
import { useUrlParams } from "@/hooks/use-url-params";
import { api, errorMessage, qk } from "@/lib/api";
import type { MessageListParams, MessageLog, MsgChannel } from "@/lib/api/types";
import { useSession } from "@/lib/auth/session";
import { downloadBlob, filenameFromDisposition } from "@/lib/download";
import { formatDateTime, formatNumber } from "@/lib/format";
import { MessageDrawer } from "./message-drawer";

const PAGE = 100;

const STATUS_OPTIONS = [
  { value: "DELIVERED", label: "Delivered" },
  { value: "ACCEPTED,QUEUED,SUBMITTED", label: "In flight (accepted / queued / submitted)" },
  { value: "UNDELIVERED,FAILED,EXPIRED,REJECTED", label: "All failures" },
  { value: "ACCEPTED", label: "Accepted" },
  { value: "QUEUED", label: "Queued" },
  { value: "SUBMITTED", label: "Submitted" },
  { value: "UNDELIVERED", label: "Undelivered" },
  { value: "FAILED", label: "Failed" },
  { value: "EXPIRED", label: "Expired" },
  { value: "REJECTED", label: "Rejected" },
  { value: "UNKNOWN", label: "Unknown" },
];

const CHANNELS: MsgChannel[] = ["HTTP", "SMPP", "WEB"];
const FILTERS = ["status", "destination", "source", "route_id", "org_id", "channel", "q", "campaign_id"] as const;

/** Money column per role: what the viewer charged / was charged. */
function chargeOf(m: MessageLog, role: string): number | null {
  if (role === "SUPER_ADMIN") return m.reseller_cost_micros ?? m.client_cost_micros;
  return m.client_cost_micros;
}

export function MessagesPage() {
  const { role } = useSession();
  const currency = useCurrency();
  const { range, resolved, setRange } = useDateRangeParam("7d");
  const { values: f, set, clear } = useUrlParams(FILTERS);
  const children = useChildOrgOptions(role !== "CLIENT");
  const routes = useRouteOptions();
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState<MessageLog | null>(null);

  const params: MessageListParams = useMemo(
    () => ({
      from_date: resolved.fromIso,
      to_date: resolved.toIso,
      status: f.status,
      destination: f.destination,
      source: f.source,
      route_id: f.route_id,
      org_id: f.org_id,
      channel: f.channel as MsgChannel | undefined,
      q: f.q,
      campaign_id: f.campaign_id,
    }),
    [resolved.fromIso, resolved.toIso, f],
  );

  const q = useInfiniteQuery({
    queryKey: qk.messages.list({ ...params, limit: PAGE }),
    queryFn: ({ pageParam }) => api.messages.list({ ...params, limit: PAGE, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor ?? null,
  });
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const res = await api.messages.export(params);
      const blob = await res.blob();
      downloadBlob(blob, filenameFromDisposition(res.headers.get("Content-Disposition"), "messages.csv"));
      toast.success("Export ready");
    } catch (e) {
      toast.error("Export failed", { description: errorMessage(e) });
    } finally {
      setExporting(false);
    }
  };

  const chargeLabel = role === "CLIENT" ? "Cost" : role === "RESELLER" ? "Client charge" : "Reseller charge";
  const columns: Column<MessageLog>[] = [
    { id: "created_at", header: "Time", cell: (m) => <span className="whitespace-nowrap text-sm">{formatDateTime(m.created_at)}</span> },
    ...(role !== "CLIENT"
      ? [{ id: "org", header: "Account", hideOnMobile: true, cell: (m: MessageLog) => m.org_name ?? m.org_id.slice(0, 8) }]
      : []),
    { id: "to", header: "To", cell: (m) => <span className="font-mono text-sm">{m.destination_addr}</span> },
    { id: "from", header: "From", hideOnMobile: true, cell: (m) => <span className="font-mono text-sm">{m.source_addr ?? "—"}</span> },
    {
      id: "text",
      header: "Text",
      hideOnMobile: true,
      cell: (m) => (
        <span className="line-clamp-1 max-w-[18rem] text-sm" title={m.orig_text}>
          {m.orig_text}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (m) => (
        <div className="flex flex-col items-start gap-0.5">
          <StatusBadge status={m.status} />
          {m.error_code ? <span className="font-mono text-[10px] text-muted-foreground">{m.error_code}</span> : null}
        </div>
      ),
    },
    { id: "route", header: "Route", hideOnMobile: true, cell: (m) => m.route_name ?? "—" },
    {
      id: "channel",
      header: "Channel",
      hideOnMobile: true,
      cell: (m) => (
        <Badge variant="outline" className="font-mono text-[10px]">
          {m.channel}
        </Badge>
      ),
    },
    { id: "parts", header: "Parts", align: "right", hideOnMobile: true, cell: (m) => m.parts },
    { id: "cost", header: chargeLabel, align: "right", cell: (m) => <Money micros={chargeOf(m, role)} currency={currency} /> },
  ];

  const anyFilter = FILTERS.some((k) => !!f[k]) || range.preset !== "7d";

  return (
    <>
      <PageHeader
        title={role === "CLIENT" ? "Messages" : "Messages & DLR"}
        description="Every message with its delivery report. Click a row for details."
        actions={
          <Button variant="outline" onClick={exportCsv} disabled={exporting}>
            {exporting ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />}
            Export CSV
          </Button>
        }
      />
      <DataTable
        caption="Messages"
        columns={columns}
        data={rows}
        rowKey={(m) => m.id}
        isLoading={q.isLoading}
        isFetching={q.isFetching && !q.isFetchingNextPage}
        error={q.error}
        onRetry={() => q.refetch()}
        onRowClick={setSelected}
        empty={{ title: "No messages", description: "Nothing matches these filters in the selected period." }}
        toolbar={
          <>
            <DateRangePicker value={range} onChange={setRange} />
            <SelectFilter
              label="Status"
              allLabel="All statuses"
              value={f.status}
              onChange={(v) => set({ status: v })}
              options={STATUS_OPTIONS}
            />
            <SearchFilter
              value={f.destination}
              onChange={(v) => set({ destination: v ? v.replace(/[\s\-+().]/g, "") : undefined })}
              placeholder="Destination or prefix"
              label="Destination"
              className="sm:w-44"
              maxLength={32}
            />
            <SearchFilter value={f.source} onChange={(v) => set({ source: v })} placeholder="Sender" label="Sender" className="sm:w-36" maxLength={21} />
            <SelectFilter
              label="Route"
              allLabel="All routes"
              value={f.route_id}
              onChange={(v) => set({ route_id: v })}
              options={routes.options.map((r) => ({ value: r.value, label: r.label }))}
            />
            {role !== "CLIENT" ? (
              <SelectFilter
                label={role === "SUPER_ADMIN" ? "Reseller" : "Client"}
                allLabel={role === "SUPER_ADMIN" ? "All resellers" : "All clients"}
                value={f.org_id}
                onChange={(v) => set({ org_id: v })}
                options={children.options}
              />
            ) : null}
            <SelectFilter
              label="Channel"
              allLabel="All channels"
              value={f.channel}
              onChange={(v) => set({ channel: v })}
              options={CHANNELS.map((c) => ({ value: c, label: c === "WEB" ? "Web panel" : c }))}
              className="sm:w-36"
            />
            <SearchFilter value={f.q} onChange={(v) => set({ q: v })} placeholder="Text, message ID or client ref" label="Search" maxLength={200} />
            {f.campaign_id ? (
              <Badge variant="secondary" className="gap-1">
                Campaign {f.campaign_id.slice(0, 8)}
                <button type="button" aria-label="Clear campaign filter" className="ml-1" onClick={() => set({ campaign_id: undefined })}>
                  ×
                </button>
              </Badge>
            ) : null}
            <ResetFiltersButton visible={anyFilter} onClick={clear} />
          </>
        }
      />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <span aria-live="polite">
          {formatNumber(rows.length)} {rows.length === 1 ? "message" : "messages"} loaded
          {q.hasNextPage ? " · more available" : ""}
        </span>
        {q.hasNextPage ? (
          <Button variant="outline" size="sm" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
            {q.isFetchingNextPage ? <Loader2 className="animate-spin" aria-hidden /> : null}
            Load more
          </Button>
        ) : null}
      </div>
      <MessageDrawer
        id={selected?.id ?? null}
        initial={selected ?? undefined}
        onClose={() => setSelected(null)}
        role={role}
        currency={currency}
      />
    </>
  );
}
