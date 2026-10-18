"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
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
import { Money } from "@/components/shared/money";
import { PageHeader } from "@/components/shared/page-header";
import { BoolBadge, humanize } from "@/components/shared/status-badge";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { useTableState } from "@/hooks/use-table-state";
import { api, qk } from "@/lib/api";
import type { CreateRouteRequest, Route, RouteAssignment } from "@/lib/api/types";
import { useSession } from "@/lib/auth/session";
import { formatDate, formatNumber } from "@/lib/format";
import { RouteForm } from "./route-form";

function AdminRoutes() {
  const router = useRouter();
  const t = useTableState({ filters: ["q"] as const });
  const q = useQuery({
    queryKey: qk.routes.list(t.params),
    queryFn: () => api.routes.list(t.params),
    placeholderData: keepPreviousData,
  });
  const [open, setOpen] = useState(false);
  const create = useApiMutation({
    mutationFn: (body: CreateRouteRequest) => api.routes.create(body),
    success: (r) => `Route “${r.name}” created`,
    invalidate: [qk.routes.all, qk.dashboard],
    onSuccess: (r) => {
      setOpen(false);
      router.push(`/routes/${r.id}`);
    },
  });

  const columns: Column<Route>[] = [
    {
      id: "name",
      header: "Name",
      cell: (r) => (
        <div className="min-w-0">
          <Link href={`/routes/${r.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
            {r.name}
          </Link>
          {r.description ? <div className="max-w-xs truncate text-xs text-muted-foreground">{r.description}</div> : null}
        </div>
      ),
    },
    { id: "enabled", header: "Status", cell: (r) => <BoolBadge value={r.enabled} /> },
    {
      id: "template_mode",
      header: "Template mode",
      hideOnMobile: true,
      cell: (r) =>
        r.template_mode ? (
          <span className="text-sm">
            On <span className="text-muted-foreground">· fallback {humanize(r.template_fallback).toLowerCase()}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">Off</span>
        ),
    },
    {
      id: "force_sender_id",
      header: "Forced sender",
      hideOnMobile: true,
      cell: (r) => (r.force_sender_id ? <code className="text-sm">{r.force_sender_id}</code> : "—"),
    },
    {
      id: "connection_count",
      header: "Connections",
      align: "right",
      hideOnMobile: true,
      cell: (r) =>
        r.connection_count !== undefined ? (
          <span className={r.enabled_connection_count === 0 ? "text-destructive" : undefined}>
            {formatNumber(r.enabled_connection_count)} / {formatNumber(r.connection_count)}
          </span>
        ) : (
          "—"
        ),
    },
    {
      id: "assigned_org_count",
      header: "Assigned to",
      align: "right",
      hideOnMobile: true,
      cell: (r) => formatNumber(r.assigned_org_count),
    },
    { id: "updated_at", header: "Updated", hideOnMobile: true, cell: (r) => formatDate(r.updated_at) },
  ];

  return (
    <>
      <PageHeader
        title="Routes"
        description="Named routing products mapped to upstream connections. Assign them to resellers with a rate."
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus /> New route
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>New route</DialogTitle>
                <DialogDescription>Map connections after creating the route.</DialogDescription>
              </DialogHeader>
              <RouteForm pending={create.isPending} onSubmit={(b) => create.mutate(b)} submitLabel="Create route" />
            </DialogContent>
          </Dialog>
        }
      />
      <DataTable
        caption="Routes"
        columns={columns}
        data={q.data}
        rowKey={(r) => r.id}
        isLoading={q.isLoading}
        isFetching={q.isFetching}
        error={q.error}
        onRetry={() => q.refetch()}
        state={t.state}
        onStateChange={t.setState}
        onRowClick={(r) => router.push(`/routes/${r.id}`)}
        empty={{ title: "No routes" }}
        toolbar={
          <>
            <SearchFilter value={t.filters.q} onChange={(v) => t.setFilter("q", v)} placeholder="Search routes…" />
            <ResetFiltersButton visible={!!t.filters.q} onClick={t.resetFilters} />
          </>
        }
      />
    </>
  );
}

function ResellerRoutes() {
  const { org } = useSession();
  const q = useQuery({ queryKey: qk.orgs.routes(org.id), queryFn: () => api.orgs.routes(org.id) });
  const balance = useQuery({ queryKey: qk.orgs.balance(org.id), queryFn: () => api.orgs.balance(org.id) });
  const currency = balance.data?.currency ?? "USD";
  const assigned = useQuery({
    queryKey: qk.routes.assigned({ page_size: 200 }),
    queryFn: () => api.routes.listAssigned({ page_size: 200 }),
  });
  const templateMode = (routeId: string) => assigned.data?.items.find((r) => r.id === routeId)?.template_mode;

  const columns: Column<RouteAssignment>[] = [
    { id: "route_name", header: "Route", cell: (a) => <span className="font-medium">{a.route_name}</span> },
    {
      id: "prefix",
      header: "Prefix",
      cell: (a) => (a.prefix ? <code className="text-sm">{a.prefix}</code> : <span className="text-muted-foreground">all</span>),
    },
    {
      id: "rate_micros",
      header: "My cost / segment",
      align: "right",
      cell: (a) => <Money micros={a.rate_micros} currency={currency} />,
    },
    { id: "priority", header: "Priority", align: "right", hideOnMobile: true, cell: (a) => a.priority },
    {
      id: "template",
      header: "OTP templates",
      hideOnMobile: true,
      cell: (a) => (templateMode(a.route_id) ? <Badge variant="secondary">Template mode</Badge> : "—"),
    },
    { id: "enabled", header: "Status", cell: (a) => <BoolBadge value={a.enabled} /> },
  ];

  return (
    <>
      <PageHeader
        title="Routes"
        description="Routes assigned to you and what you pay per segment. Resell them to clients from each client's Routes tab."
      />
      <DataTable
        caption="Assigned routes"
        columns={columns}
        data={q.data}
        rowKey={(a) => a.id}
        isLoading={q.isLoading}
        error={q.error}
        onRetry={() => q.refetch()}
        empty={{ title: "No routes assigned yet", description: "Ask your provider to assign routes to your account." }}
      />
    </>
  );
}

export function RoutesPage() {
  const { role } = useSession();
  return role === "SUPER_ADMIN" ? <AdminRoutes /> : <ResellerRoutes />;
}
