"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  DataTable,
  ResetFiltersButton,
  SearchFilter,
  SelectFilter,
  type Column,
} from "@/components/data-table";
import { Money } from "@/components/shared/money";
import { StatusBadge } from "@/components/shared/status-badge";
import { useTableState } from "@/hooks/use-table-state";
import { api, qk } from "@/lib/api";
import type { OrgListItem, OrgStatus } from "@/lib/api/types";
import { formatDate, formatNumber } from "@/lib/format";
import { ChannelIcons } from "./channel-icons";
import { KIND, type OrgKind } from "./kind";

const STATUS_OPTIONS = [
  { value: "ACTIVE", label: "Active" },
  { value: "SUSPENDED", label: "Suspended" },
  { value: "CLOSED", label: "Closed" },
];

/**
 * Server-paginated org list. `parentId` lists a reseller's clients (admin
 * read-only view); `linkRows=false` disables navigation to a detail page.
 */
export function OrgsTable({
  kind,
  parentId,
  linkRows = true,
  prefix,
}: {
  kind: OrgKind;
  parentId?: string;
  linkRows?: boolean;
  prefix?: string;
}) {
  const k = KIND[kind];
  const router = useRouter();
  const t = useTableState({ filters: ["q", "status"] as const, prefix });
  const params = {
    ...t.params,
    role: k.role,
    parent_id: parentId,
    status: t.params.status as OrgStatus | undefined,
  };
  const q = useQuery({
    queryKey: qk.orgs.list(params),
    queryFn: () => api.orgs.list(params),
    placeholderData: keepPreviousData,
  });

  const columns: Column<OrgListItem>[] = [
    {
      id: "name",
      header: "Name",
      cell: (o) => (
        <div className="min-w-0">
          {linkRows ? (
            <Link
              href={`${k.basePath}/${o.id}`}
              className="font-medium hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {o.name}
            </Link>
          ) : (
            <span className="font-medium">{o.name}</span>
          )}
          {o.brand_name ? (
            <div className="truncate text-xs text-muted-foreground">{o.brand_name}</div>
          ) : null}
        </div>
      ),
    },
    { id: "status", header: "Status", cell: (o) => <StatusBadge status={o.status} /> },
    { id: "channels", header: "Channels", hideOnMobile: true, cell: (o) => <ChannelIcons org={o} /> },
    {
      id: "max_tps",
      header: "TPS",
      align: "right",
      hideOnMobile: true,
      cell: (o) => formatNumber(o.max_tps),
    },
    {
      id: "balance",
      header: "Balance",
      align: "right",
      cell: (o) =>
        o.balance ? (
          <Money micros={o.balance.balance_micros} currency={o.balance.currency} decimals={2} />
        ) : (
          "—"
        ),
    },
    ...(kind === "reseller"
      ? [
          {
            id: "clients_count",
            header: "Clients",
            align: "right" as const,
            hideOnMobile: true,
            cell: (o: OrgListItem) => formatNumber(o.child_count),
          },
        ]
      : []),
    {
      id: "created_at",
      header: "Created",
      hideOnMobile: true,
      cell: (o) => formatDate(o.created_at),
    },
  ];

  return (
    <DataTable
      caption={k.plural}
      columns={columns}
      data={q.data}
      rowKey={(o) => o.id}
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      onRetry={() => q.refetch()}
      state={t.state}
      onStateChange={t.setState}
      onRowClick={linkRows ? (o) => router.push(`${k.basePath}/${o.id}`) : undefined}
      empty={{
        title: `No ${k.plural.toLowerCase()} found`,
        description: t.filters.q || t.filters.status ? "Try clearing the filters." : undefined,
      }}
      toolbar={
        <>
          <SearchFilter
            value={t.filters.q}
            onChange={(v) => t.setFilter("q", v)}
            placeholder={`Search ${k.plural.toLowerCase()}…`}
          />
          <SelectFilter
            label="Status"
            allLabel="All statuses"
            value={t.filters.status}
            onChange={(v) => t.setFilter("status", v)}
            options={STATUS_OPTIONS}
          />
          <ResetFiltersButton visible={!!(t.filters.q || t.filters.status)} onClick={t.resetFilters} />
        </>
      }
    />
  );
}
