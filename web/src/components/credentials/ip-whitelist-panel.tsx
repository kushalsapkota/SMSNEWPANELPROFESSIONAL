"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";
import { DataTable, type Column } from "@/components/data-table";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { CidrField, SelectField, SubmitButton, TextField } from "@/components/shared/form-fields";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { useTableState } from "@/hooks/use-table-state";
import { api, qk } from "@/lib/api";
import type { IpScope, IpWhitelistEntry } from "@/lib/api/types";
import { formatDate } from "@/lib/format";
import { cidrSchema } from "@/lib/validation";
import { Panel } from "./panel";

const SCOPES: Array<{ value: IpScope; label: string }> = [
  { value: "ALL", label: "All channels" },
  { value: "API", label: "HTTP API" },
  { value: "SMPP", label: "SMPP" },
  { value: "PANEL", label: "Web panel" },
];

const schema = z.object({
  cidr: cidrSchema,
  scope: z.enum(["API", "SMPP", "PANEL", "ALL"]),
  note: z.string().trim().max(200),
});
type Values = z.infer<typeof schema>;

export function IpWhitelistPanel({ orgId }: { orgId?: string }) {
  const scope = { org_id: orgId };
  const t = useTableState({ prefix: "ip", defaultPageSize: 10 });
  const params = { ...t.params, ...scope };
  const q = useQuery({
    queryKey: qk.ipWhitelist.list(params),
    queryFn: () => api.ipWhitelist.list(params),
    placeholderData: keepPreviousData,
  });
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState<IpWhitelistEntry | null>(null);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { cidr: "", scope: "ALL", note: "" } });

  const create = useApiMutation({
    mutationFn: (v: Values) => api.ipWhitelist.create({ cidr: v.cidr, scope: v.scope, note: v.note || undefined }, scope),
    success: "IP range added",
    invalidate: [qk.ipWhitelist.all],
    onSuccess: () => {
      setOpen(false);
      form.reset();
    },
  });
  const remove = useApiMutation({
    mutationFn: (e: IpWhitelistEntry) => api.ipWhitelist.remove(e.id),
    success: "IP range removed",
    invalidate: [qk.ipWhitelist.all],
  });

  const columns: Column<IpWhitelistEntry>[] = [
    { id: "cidr", header: "CIDR", cell: (e) => <code className="font-mono text-sm">{e.cidr}</code> },
    { id: "scope", header: "Scope", cell: (e) => <Badge variant="outline">{SCOPES.find((s) => s.value === e.scope)?.label ?? e.scope}</Badge> },
    { id: "note", header: "Note", hideOnMobile: true, cell: (e) => e.note || "—" },
    { id: "created_at", header: "Added", hideOnMobile: true, cell: (e) => formatDate(e.created_at) },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (e) => (
        <Button variant="ghost" size="icon" aria-label={`Remove ${e.cidr}`} onClick={() => setRemoving(e)}>
          <Trash2 />
        </Button>
      ),
    },
  ];

  return (
    <Panel
      title="IP whitelist"
      description="When a channel has at least one entry, only listed addresses may use it."
      action={
        <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) form.reset(); }}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus /> Add range
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add IP range</DialogTitle>
              <DialogDescription>Adding the first entry for a channel locks it to the whitelist.</DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="space-y-4" noValidate>
                <CidrField control={form.control} name="cidr" label="IP / CIDR" />
                <SelectField control={form.control} name="scope" label="Applies to" options={SCOPES} />
                <TextField control={form.control} name="note" label="Note" placeholder="Office NAT" />
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                  <SubmitButton pending={create.isPending}>Add</SubmitButton>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      }
    >
      <DataTable
        caption="IP whitelist"
        columns={columns}
        data={q.data}
        rowKey={(e) => e.id}
        isLoading={q.isLoading}
        isFetching={q.isFetching}
        error={q.error}
        onRetry={() => q.refetch()}
        state={t.state}
        onStateChange={t.setState}
        empty={{ title: "No restrictions", description: "Any IP address may connect." }}
      />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(v) => !v && setRemoving(null)}
        title={`Remove ${removing?.cidr}?`}
        description="If this is the last entry for the channel, the channel becomes open to every IP."
        confirmLabel="Remove"
        onConfirm={async () => {
          if (removing) await remove.mutateAsync(removing);
        }}
      />
    </Panel>
  );
}
