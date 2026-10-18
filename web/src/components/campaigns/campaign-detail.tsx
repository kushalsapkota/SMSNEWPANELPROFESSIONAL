"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/data-table";
import { PageHeader } from "@/components/shared/page-header";
import { StatCard } from "@/components/shared/stat-card";
import { ErrorState, LoadingState } from "@/components/shared/states";
import { StatusBadge } from "@/components/shared/status-badge";
import { Money } from "@/components/shared/money";
import { SmsCounter } from "@/components/messaging/sms-counter";
import { useCurrency } from "@/hooks/use-currency";
import { useTableState } from "@/hooks/use-table-state";
import { api, qk } from "@/lib/api";
import type { CampaignRecipient, MessageLog } from "@/lib/api/types";
import { formatDateTime, formatNumber, formatRelative, isoDay } from "@/lib/format";
import { findPlaceholders } from "@/lib/template-vars";
import { CampaignActions, ProgressBar, campaignProgress, isActive } from "./campaign-actions";

/** Campaign progress page; polls every 3s while the campaign is running / scheduled. */
export function CampaignDetail({ id }: { id: string }) {
  const currency = useCurrency();
  const q = useQuery({
    queryKey: qk.campaigns.detail(id),
    queryFn: () => api.campaigns.get(id),
    refetchInterval: (query) => (query.state.data && isActive(query.state.data.status) ? 3000 : false),
  });
  const c = q.data;
  // Messages of this campaign (CDRs are date-bounded: from creation to now + 1 day).
  const msgParams = useMemo(
    () =>
      c
        ? {
            campaign_id: c.id,
            from_date: new Date(Math.max(new Date(c.created_at).getTime() - 60_000, Date.now() - 365 * 86_400_000)).toISOString(),
            to_date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 13) + ":00:00.000Z",
            limit: 50,
          }
        : null,
    [c],
  );
  const msgs = useQuery({
    queryKey: qk.messages.list(msgParams ?? {}),
    queryFn: () => api.messages.list(msgParams!),
    enabled: !!msgParams,
    placeholderData: keepPreviousData,
    refetchInterval: c && isActive(c.status) ? 5000 : false,
  });

  if (q.isLoading) return <LoadingState rows={6} />;
  if (q.isError || !c) {
    return (
      <>
        <PageHeader title="Campaign" back={{ href: "/campaigns", label: "Campaigns" }} />
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      </>
    );
  }

  const pct = campaignProgress(c);
  const remaining = c.pending ?? Math.max(0, c.total - c.submitted - c.failed);
  const durationS =
    c.started_at && (c.finished_at || isActive(c.status))
      ? ((c.finished_at ? new Date(c.finished_at).getTime() : Date.now()) - new Date(c.started_at).getTime()) / 1000
      : null;
  const rate = durationS && durationS > 0 ? (c.submitted + c.failed) / durationS : null;
  const placeholders = findPlaceholders(c.body);

  const columns: Column<MessageLog>[] = [
    { id: "to", header: "To", cell: (m) => <span className="font-mono text-sm">{m.destination_addr}</span> },
    { id: "status", header: "Status", cell: (m) => <StatusBadge status={m.status} /> },
    {
      id: "text",
      header: "Sent text",
      hideOnMobile: true,
      cell: (m) => <span className="line-clamp-1 max-w-[24rem] text-sm">{m.sent_text ?? m.orig_text}</span>,
    },
    { id: "parts", header: "Parts", align: "right", hideOnMobile: true, cell: (m) => m.parts },
    { id: "cost", header: "Cost", align: "right", cell: (m) => <Money micros={m.client_cost_micros} currency={currency} /> },
    { id: "at", header: "Created", hideOnMobile: true, cell: (m) => formatDateTime(m.created_at) },
  ];

  return (
    <>
      <PageHeader
        title={c.name}
        back={{ href: "/campaigns", label: "Campaigns" }}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={c.status} />
            <span>
              from <span className="font-mono">{c.source_addr}</span> · created {formatRelative(c.created_at)}
            </span>
          </span>
        }
        actions={<CampaignActions campaign={c} size="default" />}
      />

      <Card className="mb-6">
        <CardContent className="space-y-3 pt-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-3xl font-semibold">{pct.toFixed(pct > 0 && pct < 1 ? 1 : 0)}%</span>
            <span className="text-sm text-muted-foreground" aria-live="polite">
              {formatNumber(c.submitted + c.failed)} of {formatNumber(c.total)} processed
              {rate ? ` · ${rate.toFixed(1)} msg/s` : ""}
              {isActive(c.status) ? " · updating every 3s" : ""}
            </span>
          </div>
          <ProgressBar value={pct} label="Campaign progress" className="h-3" />
        </CardContent>
      </Card>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Recipients" value={formatNumber(c.total)} />
        <StatCard title="Submitted" tone="success" value={formatNumber(c.submitted)} />
        <StatCard title="Failed" tone={c.failed > 0 ? "destructive" : "default"} value={formatNumber(c.failed)} />
        <StatCard title="Remaining" value={formatNumber(remaining)} />
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Message</CardTitle>
            {placeholders.length ? (
              <CardDescription>
                Personalised with {placeholders.map((p) => `{${p}}`).join(", ")}
              </CardDescription>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 text-sm">{c.body}</p>
            <SmsCounter text={c.body} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Timeline</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <TimelineRow label="Created" value={formatDateTime(c.created_at)} />
            <TimelineRow label="Scheduled for" value={formatDateTime(c.scheduled_at)} />
            <TimelineRow label="Started" value={formatDateTime(c.started_at)} />
            <TimelineRow label="Finished" value={formatDateTime(c.finished_at)} />
            <TimelineRow label="Last update" value={formatDateTime(c.updated_at)} />
          </CardContent>
        </Card>
      </div>

      {c.failed > 0 ? <FailedRecipients id={c.id} active={isActive(c.status)} /> : null}

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="text-base">Latest messages</CardTitle>
            <CardDescription>Most recent 50 messages of this campaign.</CardDescription>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link href={`/messages?campaign_id=${c.id}&range=custom&from=${isoDay(new Date(c.created_at))}&to=${isoDay()}`}>
              <ExternalLink aria-hidden /> Open in Messages
            </Link>
          </Button>
        </CardHeader>
        <CardContent>
          <DataTable
            caption="Campaign messages"
            columns={columns}
            data={msgs.data?.items}
            rowKey={(m) => m.id}
            isLoading={msgs.isLoading}
            isFetching={msgs.isFetching}
            error={msgs.error}
            onRetry={() => msgs.refetch()}
            empty={{ title: c.status === "DRAFT" || c.status === "SCHEDULED" ? "Not started yet" : "No messages yet" }}
          />
        </CardContent>
      </Card>
    </>
  );
}

/** Recipients the gateway rejected (per-recipient error codes). */
function FailedRecipients({ id, active }: { id: string; active: boolean }) {
  const t = useTableState({ prefix: "fr", defaultPageSize: 10 });
  const params = { ...t.params, state: "failed" as const };
  const q = useQuery({
    queryKey: qk.campaigns.recipients(id, params),
    queryFn: () => api.campaigns.recipients(id, params),
    placeholderData: keepPreviousData,
    refetchInterval: active ? 10_000 : false,
  });
  const columns: Column<CampaignRecipient>[] = [
    { id: "seq", header: "#", cell: (r) => <span className="tabular-nums text-muted-foreground">{r.seq}</span> },
    { id: "to", header: "To", cell: (r) => <span className="font-mono text-sm">{r.destination}</span> },
    {
      id: "error",
      header: "Error",
      cell: (r) => (
        <Badge variant="destructive" className="font-mono">
          {r.error_code ?? "—"}
        </Badge>
      ),
    },
    {
      id: "vars",
      header: "Variables",
      hideOnMobile: true,
      cell: (r) => (
        <span className="line-clamp-1 max-w-[24rem] font-mono text-xs text-muted-foreground">
          {Object.entries(r.vars ?? {})
            .map(([k, v]) => `${k}=${v}`)
            .join(" · ") || "—"}
        </span>
      ),
    },
  ];
  return (
    <Card className="mb-6">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Failed recipients</CardTitle>
        <CardDescription>Rejected by the gateway before submission (e.g. ROUTE_NOT_FOUND, DESTINATION_BLOCKED).</CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable
          caption="Failed recipients"
          columns={columns}
          data={q.data}
          rowKey={(r) => r.seq}
          isLoading={q.isLoading}
          isFetching={q.isFetching}
          error={q.error}
          onRetry={() => q.refetch()}
          state={t.state}
          onStateChange={t.setState}
          empty={{ title: "No failed recipients" }}
        />
      </CardContent>
    </Card>
  );
}

function TimelineRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
