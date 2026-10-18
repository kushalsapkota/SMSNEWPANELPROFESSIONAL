"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { DataTable, ResetFiltersButton, SelectFilter, type Column } from "@/components/data-table";
import { PageHeader } from "@/components/shared/page-header";
import { StatusBadge } from "@/components/shared/status-badge";
import { useTableState } from "@/hooks/use-table-state";
import { api, qk } from "@/lib/api";
import type { Campaign, CampaignStatus } from "@/lib/api/types";
import { formatDateTime, formatNumber } from "@/lib/format";
import { CampaignActions, ProgressBar, campaignProgress, isActive } from "./campaign-actions";

const STATUSES: CampaignStatus[] = ["DRAFT", "SCHEDULED", "RUNNING", "PAUSED", "COMPLETED", "CANCELLED", "FAILED"];

export function CampaignsList() {
  const router = useRouter();
  const t = useTableState({ filters: ["status"] as const });
  const params = { ...t.params, status: t.filters.status as CampaignStatus | undefined };
  const q = useQuery({
    queryKey: qk.campaigns.list(params),
    queryFn: () => api.campaigns.list(params),
    placeholderData: keepPreviousData,
    // keep progress moving while something is sending
    refetchInterval: (query) => (query.state.data?.items.some((c) => isActive(c.status)) ? 5000 : false),
  });

  const columns: Column<Campaign>[] = [
    {
      id: "name",
      header: "Campaign",
      cell: (c) => (
        <div className="min-w-0">
          <Link href={`/campaigns/${c.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
            {c.name}
          </Link>
          <p className="truncate text-xs text-muted-foreground">
            from <span className="font-mono">{c.source_addr}</span>
          </p>
        </div>
      ),
    },
    { id: "status", header: "Status", cell: (c) => <StatusBadge status={c.status} /> },
    {
      id: "progress",
      header: "Progress",
      hideOnMobile: true,
      cell: (c) => (
        <div className="w-40 space-y-1">
          <ProgressBar value={campaignProgress(c)} label={`${c.name} progress`} />
          <p className="text-xs tabular-nums text-muted-foreground">
            {formatNumber(c.submitted)} sent · {formatNumber(c.failed)} failed / {formatNumber(c.total)}
          </p>
        </div>
      ),
    },
    {
      id: "when",
      header: "Scheduled / started",
      hideOnMobile: true,
      cell: (c) => formatDateTime(c.started_at ?? c.scheduled_at),
    },
    { id: "created", header: "Created", hideOnMobile: true, cell: (c) => formatDateTime(c.created_at) },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (c) => (
        <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} role="presentation">
          <CampaignActions campaign={c} />
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Campaigns"
        description="Bulk sends from a CSV or a pasted list, with {column} personalisation and scheduling."
        actions={
          <Button asChild>
            <Link href="/campaigns/new">
              <Plus aria-hidden /> New campaign
            </Link>
          </Button>
        }
      />
      <DataTable
        caption="Campaigns"
        columns={columns}
        data={q.data}
        rowKey={(c) => c.id}
        isLoading={q.isLoading}
        isFetching={q.isFetching}
        error={q.error}
        onRetry={() => q.refetch()}
        state={t.state}
        onStateChange={t.setState}
        onRowClick={(c) => router.push(`/campaigns/${c.id}`)}
        empty={{
          title: "No campaigns yet",
          description: "Upload a CSV with a phone column, write a message with {placeholders} and send or schedule it.",
          action: (
            <Button asChild size="sm">
              <Link href="/campaigns/new">
                <Plus aria-hidden /> New campaign
              </Link>
            </Button>
          ),
        }}
        toolbar={
          <>
            <SelectFilter
              label="Status"
              allLabel="All statuses"
              value={t.filters.status}
              onChange={(v) => t.setFilter("status", v)}
              options={STATUSES.map((s) => ({ value: s, label: s[0] + s.slice(1).toLowerCase() }))}
            />
            <ResetFiltersButton visible={!!t.filters.status} onClick={t.resetFilters} />
          </>
        }
      />
    </>
  );
}
