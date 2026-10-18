"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Lock, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { DataTable, ResetFiltersButton, SearchFilter, type Column } from "@/components/data-table";
import { PageHeader } from "@/components/shared/page-header";
import { BoolBadge } from "@/components/shared/status-badge";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { useTableState } from "@/hooks/use-table-state";
import { api, qk } from "@/lib/api";
import type { Connection, CreateConnectionRequest } from "@/lib/api/types";
import { formatNumber } from "@/lib/format";
import { ConnectionForm } from "./connection-form";

export function ConnectionsList() {
  const router = useRouter();
  const t = useTableState({ filters: ["q"] as const });
  const q = useQuery({
    queryKey: qk.connections.list(t.params),
    queryFn: () => api.connections.list(t.params),
    placeholderData: keepPreviousData,
  });
  const [open, setOpen] = useState(false);
  const create = useApiMutation({
    mutationFn: (body: CreateConnectionRequest) => api.connections.create(body),
    success: (c) => `Connection “${c.name}” created`,
    invalidate: [qk.connections.all, qk.dashboard],
    onSuccess: (c) => {
      setOpen(false);
      router.push(`/connections/${c.id}?tab=rates`);
    },
  });

  const columns: Column<Connection>[] = [
    {
      id: "name",
      header: "Name",
     
      cell: (c) => (
        <Link href={`/connections/${c.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
          {c.name}
        </Link>
      ),
    },
    {
      id: "host",
      header: "Endpoint",
      cell: (c) => (
        <span className="inline-flex items-center gap-1 font-mono text-sm">
          {c.use_tls ? <Lock className="h-3 w-3" aria-label="TLS" /> : null}
          {c.host}:{c.port}
        </span>
      ),
    },
    { id: "system_id", header: "System ID", hideOnMobile: true, cell: (c) => <code className="text-sm">{c.system_id}</code> },
    { id: "bind_type", header: "Bind", hideOnMobile: true, cell: (c) => `${c.bind_type} × ${c.sessions}` },
    { id: "max_tps", header: "Max TPS", align: "right", hideOnMobile: true, cell: (c) => formatNumber(c.max_tps) },
    { id: "enabled", header: "Status", cell: (c) => <BoolBadge value={c.enabled} /> },
  ];

  return (
    <>
      <PageHeader
        title="Connections"
        description="Upstream SMPP binds to carriers / aggregators. Live state is on the Monitor page."
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus /> New connection
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-4xl">
              <DialogHeader>
                <DialogTitle>New upstream connection</DialogTitle>
                <DialogDescription>The engine binds as soon as the connection is saved and enabled.</DialogDescription>
              </DialogHeader>
              <ConnectionForm pending={create.isPending} onSubmit={(b) => create.mutate(b)} submitLabel="Create connection" />
            </DialogContent>
          </Dialog>
        }
      />
      <DataTable
        caption="Connections"
        columns={columns}
        data={q.data}
        rowKey={(c) => c.id}
        isLoading={q.isLoading}
        isFetching={q.isFetching}
        error={q.error}
        onRetry={() => q.refetch()}
        state={t.state}
        onStateChange={t.setState}
        onRowClick={(c) => router.push(`/connections/${c.id}`)}
        empty={{ title: "No connections", description: "Add an upstream SMPP connection to start routing traffic." }}
        toolbar={
          <>
            <SearchFilter value={t.filters.q} onChange={(v) => t.setFilter("q", v)} placeholder="Search name or host…" />
            <ResetFiltersButton visible={!!t.filters.q} onClick={t.resetFilters} />
          </>
        }
      />
    </>
  );
}
