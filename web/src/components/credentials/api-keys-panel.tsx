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
import { CheckboxGroupField, SubmitButton, TextField } from "@/components/shared/form-fields";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { useTableState } from "@/hooks/use-table-state";
import { api, qk } from "@/lib/api";
import type { ApiKey } from "@/lib/api/types";
import { formatDate, formatDateTime, formatRelative } from "@/lib/format";
import { Panel } from "./panel";
import { SecretRevealDialog } from "./secret-reveal-dialog";

const schema = z.object({
  name: z.string().trim().min(1, "Required").max(100),
  scopes: z.array(z.string()).min(1, "Pick at least one scope"),
  expires_at: z
    .string()
    .refine((v) => v === "" || new Date(v).getTime() > Date.now(), "Must be in the future"),
});
type Values = z.infer<typeof schema>;

function keyState(k: ApiKey): { label: string; variant: "success" | "muted" | "destructive" } {
  if (k.revoked_at) return { label: "Revoked", variant: "destructive" };
  if (k.expires_at && new Date(k.expires_at).getTime() < Date.now()) return { label: "Expired", variant: "muted" };
  return { label: "Active", variant: "success" };
}

/** API keys of `orgId` (undefined = acting org). */
export function ApiKeysPanel({ orgId }: { orgId?: string }) {
  const scope = { org_id: orgId };
  const t = useTableState({ prefix: "key", defaultPageSize: 10 });
  const params = { ...t.params, ...scope };
  const q = useQuery({
    queryKey: qk.apiKeys.list(params),
    queryFn: () => api.apiKeys.list(params),
    placeholderData: keepPreviousData,
  });
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", scopes: ["sms:send", "sms:read"], expires_at: "" },
  });

  const create = useApiMutation({
    mutationFn: (v: Values) =>
      api.apiKeys.create(
        { name: v.name, scopes: v.scopes, expires_at: v.expires_at ? new Date(v.expires_at).toISOString() : null },
        scope,
      ),
    success: "API key created",
    invalidate: [qk.apiKeys.all, qk.orgs.all],
    onSuccess: (res) => {
      setOpen(false);
      form.reset();
      setSecret(res.key);
    },
  });
  const revoke = useApiMutation({
    mutationFn: (k: ApiKey) => api.apiKeys.revoke(k.id),
    success: "API key revoked",
    invalidate: [qk.apiKeys.all, qk.orgs.all],
  });

  const columns: Column<ApiKey>[] = [
    {
      id: "name",
      header: "Name",
      cell: (k) => (
        <div className="min-w-0">
          <div className="font-medium">{k.name}</div>
          <code className="text-xs text-muted-foreground">{k.key_prefix}…</code>
        </div>
      ),
    },
    {
      id: "state",
      header: "Status",
      cell: (k) => {
        const s = keyState(k);
        return <Badge variant={s.variant}>{s.label}</Badge>;
      },
    },
    { id: "scopes", header: "Scopes", hideOnMobile: true, cell: (k) => k.scopes.join(", ") },
    {
      id: "last_used_at",
      header: "Last used",
      hideOnMobile: true,
      cell: (k) => <span title={formatDateTime(k.last_used_at)}>{formatRelative(k.last_used_at)}</span>,
    },
    { id: "expires_at", header: "Expires", hideOnMobile: true, cell: (k) => (k.expires_at ? formatDate(k.expires_at) : "Never") },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (k) =>
        k.revoked_at ? null : (
          <Button variant="ghost" size="icon" aria-label={`Revoke ${k.name}`} onClick={() => setRevoking(k)}>
            <Trash2 />
          </Button>
        ),
    },
  ];

  return (
    <Panel
      title="API keys"
      description="Bearer keys for the /v1 HTTP API."
      action={
        <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) form.reset(); }}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus /> New key
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New API key</DialogTitle>
              <DialogDescription>The full key is shown once after creation.</DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="space-y-4" noValidate>
                <TextField control={form.control} name="name" label="Name" placeholder="Production server" />
                <CheckboxGroupField
                  control={form.control}
                  name="scopes"
                  label="Scopes"
                  options={[
                    { value: "sms:send", label: "sms:send" },
                    { value: "sms:read", label: "sms:read" },
                    { value: "balance:read", label: "balance:read" },
                  ]}
                />
                <TextField control={form.control} name="expires_at" label="Expires (optional)" type="datetime-local" />
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                  <SubmitButton pending={create.isPending}>Create key</SubmitButton>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      }
    >
      <DataTable
        caption="API keys"
        columns={columns}
        data={q.data}
        rowKey={(k) => k.id}
        isLoading={q.isLoading}
        isFetching={q.isFetching}
        error={q.error}
        onRetry={() => q.refetch()}
        state={t.state}
        onStateChange={t.setState}
        empty={{ title: "No API keys" }}
      />
      <SecretRevealDialog
        secret={secret}
        title="Your new API key"
        description="Use it as Authorization: Bearer <key> or the X-API-Key header."
        onClose={() => setSecret(null)}
      />
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(v) => !v && setRevoking(null)}
        title={`Revoke “${revoking?.name}”?`}
        description="Requests using this key will be rejected immediately. This cannot be undone."
        confirmLabel="Revoke key"
        onConfirm={async () => {
          if (revoking) await revoke.mutateAsync(revoking);
        }}
      />
    </Panel>
  );
}
