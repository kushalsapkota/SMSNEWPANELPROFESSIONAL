"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { History, MoreHorizontal, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
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
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Form } from "@/components/ui/form";
import { DataTable, type Column } from "@/components/data-table";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import {
  CheckboxGroupField,
  NumberField,
  SubmitButton,
  SwitchField,
  TextField,
} from "@/components/shared/form-fields";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { useTableState } from "@/hooks/use-table-state";
import { api, qk } from "@/lib/api";
import type { Webhook, WebhookDelivery } from "@/lib/api/types";
import { formatDateTime, formatRelative } from "@/lib/format";
import { Panel } from "./panel";
import { SecretRevealDialog } from "./secret-reveal-dialog";

const EVENT_OPTIONS = [{ value: "dlr", label: "Delivery reports (dlr)" }];

const schema = z.object({
  url: z
    .string()
    .trim()
    .url("Enter a full URL")
    .refine((v) => /^https?:\/\//.test(v), "Must start with http:// or https://"),
  events: z.array(z.string()).min(1, "Pick at least one event"),
  max_retries: z.number({ invalid_type_error: "Required" }).int().min(0).max(20),
  enabled: z.boolean(),
});
type Values = z.infer<typeof schema>;

function WebhookDialog({
  open,
  webhook,
  orgId,
  onClose,
  onCreated,
}: {
  open: boolean;
  webhook: Webhook | null;
  orgId?: string;
  onClose: () => void;
  onCreated: (secret: string) => void;
}) {
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { url: "", events: ["dlr"], max_retries: 8, enabled: true },
  });
  useEffect(() => {
    if (open) {
      form.reset(
        webhook
          ? { url: webhook.url, events: webhook.events, max_retries: webhook.max_retries, enabled: webhook.enabled }
          : { url: "", events: ["dlr"], max_retries: 8, enabled: true },
      );
    }
  }, [open, webhook, form]);
  const save = useApiMutation({
    mutationFn: async (v: Values) => {
      if (webhook) {
        await api.webhooks.update(webhook.id, v);
        return null;
      }
      const res = await api.webhooks.create({ url: v.url, events: v.events, max_retries: v.max_retries }, { org_id: orgId });
      return res.secret;
    },
    success: webhook ? "Webhook updated" : "Webhook created",
    invalidate: [qk.webhooks.all],
    onSuccess: (secret) => {
      onClose();
      if (secret) onCreated(secret);
    },
  });
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{webhook ? "Edit webhook" : "New webhook"}</DialogTitle>
          <DialogDescription>
            We POST signed JSON (X-Webhook-Signature: sha256=HMAC(secret, timestamp.body)).
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-4" noValidate>
            <TextField control={form.control} name="url" label="URL" type="url" placeholder="https://example.com/hooks/sms" />
            <CheckboxGroupField control={form.control} name="events" label="Events" options={EVENT_OPTIONS} />
            <NumberField control={form.control} name="max_retries" label="Max retries" min={0} max={20} description="Exponential backoff: 10s · 2^n." />
            {webhook ? <SwitchField control={form.control} name="enabled" label="Enabled" /> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <SubmitButton pending={save.isPending}>{webhook ? "Save" : "Create"}</SubmitButton>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

const deliveryColumns: Column<WebhookDelivery>[] = [
  { id: "created_at", header: "Time", cell: (d) => formatDateTime(d.created_at) },
  { id: "attempt", header: "Attempt", align: "right", cell: (d) => d.attempt },
  {
    id: "status_code",
    header: "Result",
    cell: (d) =>
      d.status_code && d.status_code >= 200 && d.status_code < 300 ? (
        <Badge variant="success">{d.status_code}</Badge>
      ) : (
        <Badge variant="destructive">{d.status_code ?? "error"}</Badge>
      ),
  },
  { id: "duration_ms", header: "Duration", align: "right", hideOnMobile: true, cell: (d) => (d.duration_ms !== null ? `${d.duration_ms} ms` : "—") },
  { id: "message_id", header: "Message", hideOnMobile: true, cell: (d) => (d.message_id ? <code className="text-xs">{d.message_id}</code> : "test") },
  { id: "error", header: "Error", hideOnMobile: true, cell: (d) => <span className="line-clamp-2 max-w-xs text-xs">{d.error ?? "—"}</span> },
];

/** Delivery log for one webhook. Exported for part 2's API & SMPP page. */
export function WebhookDeliveriesDialog({ webhook, onClose }: { webhook: Webhook | null; onClose: () => void }) {
  const [page, setPage] = useState({ page: 1, page_size: 25 });
  const id = webhook?.id ?? "";
  const q = useQuery({
    queryKey: qk.webhooks.deliveries(id, page),
    queryFn: () => api.webhooks.deliveries(id, page),
    enabled: !!webhook,
    placeholderData: keepPreviousData,
  });
  return (
    <Dialog open={!!webhook} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Delivery log</DialogTitle>
          <DialogDescription className="break-all">{webhook?.url}</DialogDescription>
        </DialogHeader>
        <DataTable
          caption="Webhook deliveries"
          columns={deliveryColumns}
          data={q.data}
          rowKey={(d) => d.id}
          isLoading={q.isLoading}
          isFetching={q.isFetching}
          error={q.error}
          onRetry={() => q.refetch()}
          state={page}
          onStateChange={(p) => setPage((s) => ({ ...s, ...p }))}
          empty={{ title: "No deliveries yet" }}
        />
      </DialogContent>
    </Dialog>
  );
}

export function WebhooksPanel({ orgId }: { orgId?: string }) {
  const t = useTableState({ prefix: "wh", defaultPageSize: 10 });
  const params = { ...t.params, org_id: orgId };
  const q = useQuery({
    queryKey: qk.webhooks.list(params),
    queryFn: () => api.webhooks.list(params),
    placeholderData: keepPreviousData,
  });
  const [dialog, setDialog] = useState<{ open: boolean; webhook: Webhook | null }>({ open: false, webhook: null });
  const [secret, setSecret] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Webhook | null>(null);
  const [logs, setLogs] = useState<Webhook | null>(null);

  const test = useApiMutation({
    mutationFn: (w: Webhook) => api.webhooks.test(w.id),
    success: false,
    invalidate: [qk.webhooks.all],
    onSuccess: (r) => {
      if (r.ok) toast.success(`Test delivered (${r.status_code ?? "OK"}${r.duration_ms !== null ? `, ${r.duration_ms} ms` : ""})`);
      else toast.error("Test delivery failed", { description: r.error ?? `HTTP ${r.status_code}` });
    },
  });
  const remove = useApiMutation({
    mutationFn: (w: Webhook) => api.webhooks.remove(w.id),
    success: "Webhook deleted",
    invalidate: [qk.webhooks.all],
  });

  const columns: Column<Webhook>[] = [
    {
      id: "url",
      header: "URL",
      cell: (w) => (
        <div className="min-w-0 max-w-[16rem] sm:max-w-md">
          <div className="truncate font-mono text-sm">{w.url}</div>
          <div className="text-xs text-muted-foreground">{w.events.join(", ")}</div>
        </div>
      ),
    },
    { id: "enabled", header: "Status", cell: (w) => (w.enabled ? <Badge variant="success">Enabled</Badge> : <Badge variant="muted">Disabled</Badge>) },
    { id: "max_retries", header: "Retries", hideOnMobile: true, align: "right", cell: (w) => w.max_retries },
    {
      id: "failures",
      header: "Failures",
      hideOnMobile: true,
      cell: (w) =>
        w.failure_count > 0 ? (
          <span className="text-destructive">
            {w.failure_count} · {formatRelative(w.last_failure_at)}
          </span>
        ) : (
          "0"
        ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (w) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={`Actions for ${w.url}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => test.mutate(w)}>
              <Send className="mr-2 h-4 w-4" /> Send test
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setLogs(w)}>
              <History className="mr-2 h-4 w-4" /> Delivery log
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setDialog({ open: true, webhook: w })}>
              <Pencil className="mr-2 h-4 w-4" /> Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive" onSelect={() => setDeleting(w)}>
              <Trash2 className="mr-2 h-4 w-4" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <Panel
      title="Webhooks"
      description="Delivery reports pushed to your HTTPS endpoint."
      action={
        <Button size="sm" onClick={() => setDialog({ open: true, webhook: null })}>
          <Plus /> New webhook
        </Button>
      }
    >
      <DataTable
        caption="Webhooks"
        columns={columns}
        data={q.data}
        rowKey={(w) => w.id}
        isLoading={q.isLoading}
        isFetching={q.isFetching}
        error={q.error}
        onRetry={() => q.refetch()}
        state={t.state}
        onStateChange={t.setState}
        empty={{ title: "No webhooks" }}
      />
      <WebhookDialog
        open={dialog.open}
        webhook={dialog.webhook}
        orgId={orgId}
        onClose={() => setDialog({ open: false, webhook: null })}
        onCreated={setSecret}
      />
      <SecretRevealDialog
        secret={secret}
        title="Webhook signing secret"
        description="Verify X-Webhook-Signature with this secret."
        onClose={() => setSecret(null)}
      />
      <WebhookDeliveriesDialog webhook={logs} onClose={() => setLogs(null)} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title="Delete webhook?"
        description={<span className="break-all">{deleting?.url}</span>}
        confirmLabel="Delete"
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting);
        }}
      />
    </Panel>
  );
}
