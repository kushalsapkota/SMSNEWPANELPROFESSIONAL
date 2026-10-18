"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Check, Plus, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DataTable,
  ResetFiltersButton,
  SearchFilter,
  SelectFilter,
  type Column,
} from "@/components/data-table";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { SelectField, SubmitButton, TextField } from "@/components/shared/form-fields";
import { PageHeader } from "@/components/shared/page-header";
import { StatusBadge } from "@/components/shared/status-badge";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { useTabParam } from "@/hooks/use-tab-param";
import { useTableState } from "@/hooks/use-table-state";
import { api, qk } from "@/lib/api";
import type { SenderId, SenderStatus } from "@/lib/api/types";
import { useSession } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { senderSchema } from "@/lib/validation";

const STATUS_OPTIONS = [
  { value: "PENDING", label: "Pending" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
];

function useRouteOptions() {
  const q = useQuery({
    queryKey: qk.routes.assigned({ page_size: 200 }),
    queryFn: () => api.routes.listAssigned({ page_size: 200 }),
    staleTime: 60_000,
  });
  return useMemo(() => (q.data?.items ?? []).map((r) => ({ value: r.id, label: r.name })), [q.data]);
}

/** Approval queue of the acting org's children (admin: resellers, reseller: clients). */
function ApprovalsTable() {
  const t = useTableState({ filters: ["status", "q"] as const, defaultPageSize: 25, prefix: "ap" });
  const status = (t.filters.status ?? "PENDING") as SenderStatus | "ALL";
  const params = {
    ...t.params,
    include_children: true,
    status: status === "ALL" ? undefined : status,
  };
  const q = useQuery({
    queryKey: qk.senderIds.list(params),
    queryFn: () => api.senderIds.list(params),
    placeholderData: keepPreviousData,
  });
  const [rejecting, setRejecting] = useState<SenderId | null>(null);
  const approve = useApiMutation({
    mutationFn: (s: SenderId) => api.senderIds.approve(s.id),
    success: (_d, s) => `“${s.sender}” approved`,
    invalidate: [qk.senderIds.all],
  });
  const reject = useApiMutation({
    mutationFn: (s: SenderId) => api.senderIds.reject(s.id),
    success: (_d, s) => `“${s.sender}” rejected`,
    invalidate: [qk.senderIds.all],
  });

  const columns: Column<SenderId>[] = [
    { id: "sender", header: "Sender", cell: (s) => <code className="font-mono text-sm font-medium">{s.sender}</code> },
    { id: "org", header: "Account", cell: (s) => s.org_name ?? s.org_id.slice(0, 8) },
    { id: "route", header: "Route", hideOnMobile: true, cell: (s) => (s.route_id ? (s.route_name ?? "Specific route") : "Any route") },
    { id: "status", header: "Status", cell: (s) => <StatusBadge status={s.status} /> },
    { id: "created_at", header: "Requested", hideOnMobile: true, cell: (s) => formatDateTime(s.created_at) },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (s) => (
        <div className="flex justify-end gap-1">
          {s.status !== "APPROVED" ? (
            <Button size="sm" variant="outline" onClick={() => approve.mutate(s)} disabled={approve.isPending}>
              <Check /> Approve
            </Button>
          ) : null}
          {s.status !== "REJECTED" ? (
            <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setRejecting(s)}>
              <X /> Reject
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <>
      <DataTable
        caption="Sender ID approvals"
        columns={columns}
        data={q.data}
        rowKey={(s) => s.id}
        isLoading={q.isLoading}
        isFetching={q.isFetching}
        error={q.error}
        onRetry={() => q.refetch()}
        state={t.state}
        onStateChange={t.setState}
        empty={{ title: status === "PENDING" ? "Nothing waiting for approval" : "No sender IDs" }}
        toolbar={
          <>
            <SearchFilter value={t.filters.q} onChange={(v) => t.setFilter("q", v)} placeholder="Search sender…" />
            <SelectFilter
              label="Status"
              allLabel="All statuses"
              value={status === "ALL" ? undefined : status}
              onChange={(v) => t.setFilter("status", v ?? "ALL")}
              options={STATUS_OPTIONS}
            />
            <ResetFiltersButton visible={!!t.filters.q || !!t.filters.status} onClick={t.resetFilters} />
          </>
        }
      />
      <ConfirmDialog
        open={!!rejecting}
        onOpenChange={(v) => !v && setRejecting(null)}
        title={`Reject sender “${rejecting?.sender}”?`}
        description="The account can no longer send with this sender ID."
        confirmLabel="Reject"
        onConfirm={async () => {
          if (rejecting) await reject.mutateAsync(rejecting);
        }}
      />
    </>
  );
}

const requestSchema = z.object({ sender: senderSchema, route_id: z.string().nullable() });

/** The acting org's own sender IDs + request form. */
function MySenderIds() {
  const t = useTableState({ filters: ["status"] as const, prefix: "my" });
  const params = { ...t.params, status: t.filters.status as SenderStatus | undefined };
  const q = useQuery({
    queryKey: qk.senderIds.list(params),
    queryFn: () => api.senderIds.list(params),
    placeholderData: keepPreviousData,
  });
  const routeOptions = useRouteOptions();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<SenderId | null>(null);
  const form = useForm<z.infer<typeof requestSchema>>({
    resolver: zodResolver(requestSchema),
    defaultValues: { sender: "", route_id: null },
  });
  const create = useApiMutation({
    mutationFn: (v: z.infer<typeof requestSchema>) => api.senderIds.create({ sender: v.sender, route_id: v.route_id }),
    success: "Sender ID requested — waiting for approval",
    invalidate: [qk.senderIds.all],
    onSuccess: () => {
      setOpen(false);
      form.reset();
    },
  });
  const remove = useApiMutation({
    mutationFn: (s: SenderId) => api.senderIds.remove(s.id),
    success: "Sender ID removed",
    invalidate: [qk.senderIds.all],
  });

  const columns: Column<SenderId>[] = [
    { id: "sender", header: "Sender", cell: (s) => <code className="font-mono text-sm font-medium">{s.sender}</code> },
    { id: "route", header: "Route", hideOnMobile: true, cell: (s) => (s.route_id ? (s.route_name ?? routeOptions.find((r) => r.value === s.route_id)?.label ?? "Specific route") : "Any route") },
    { id: "status", header: "Status", cell: (s) => <StatusBadge status={s.status} /> },
    { id: "reviewed_at", header: "Reviewed", hideOnMobile: true, cell: (s) => formatDateTime(s.reviewed_at) },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (s) => (
        <Button variant="ghost" size="icon" aria-label={`Remove ${s.sender}`} onClick={() => setDeleting(s)}>
          <Trash2 />
        </Button>
      ),
    },
  ];

  return (
    <>
      <DataTable
        caption="My sender IDs"
        columns={columns}
        data={q.data}
        rowKey={(s) => s.id}
        isLoading={q.isLoading}
        isFetching={q.isFetching}
        error={q.error}
        onRetry={() => q.refetch()}
        state={t.state}
        onStateChange={t.setState}
        empty={{
          title: "No sender IDs",
          description: "Without any sender IDs you may send with any sender. Once you have one, only approved senders are accepted.",
        }}
        toolbar={
          <>
            <SelectFilter
              label="Status"
              allLabel="All statuses"
              value={t.filters.status}
              onChange={(v) => t.setFilter("status", v)}
              options={STATUS_OPTIONS}
            />
            <div className="ml-auto">
              <Button onClick={() => setOpen(true)}>
                <Plus /> Request sender ID
              </Button>
            </div>
          </>
        }
      />
      <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) form.reset(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request sender ID</DialogTitle>
            <DialogDescription>Your provider reviews the request before it can be used.</DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="space-y-4" noValidate>
              <TextField
                control={form.control}
                name="sender"
                label="Sender"
                mono
                placeholder="MYBANK"
                description="Alphanumeric up to 11 characters, or a number up to 15 digits."
              />
              <SelectField control={form.control} name="route_id" label="Route" options={routeOptions} nullable noneLabel="Any route" />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <SubmitButton pending={create.isPending}>Submit request</SubmitButton>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title={`Remove sender “${deleting?.sender}”?`}
        description="Messages using this sender will be rejected (SENDER_NOT_ALLOWED) if you have other sender IDs."
        confirmLabel="Remove"
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting);
        }}
      />
    </>
  );
}

export function SenderIdsPage() {
  const { role } = useSession();
  const [tab, setTab] = useTabParam(["approvals", "mine"] as const, "approvals");
  if (role === "CLIENT") {
    return (
      <>
        <PageHeader title="Sender IDs" description="Sender names and numbers you're allowed to send from." />
        <MySenderIds />
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Sender IDs"
        description={role === "SUPER_ADMIN" ? "Approve sender IDs requested by resellers." : "Approve sender IDs requested by your clients."}
      />
      {role === "RESELLER" ? (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="approvals">Client approvals</TabsTrigger>
            <TabsTrigger value="mine">My sender IDs</TabsTrigger>
          </TabsList>
          <TabsContent value="approvals" className="mt-4">
            <ApprovalsTable />
          </TabsContent>
          <TabsContent value="mine" className="mt-4">
            <MySenderIds />
          </TabsContent>
        </Tabs>
      ) : (
        <ApprovalsTable />
      )}
    </>
  );
}
