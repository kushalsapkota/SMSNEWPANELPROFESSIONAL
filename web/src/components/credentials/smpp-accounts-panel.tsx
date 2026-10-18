"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { KeyRound, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Form } from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";
import { DataTable, type Column } from "@/components/data-table";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import {
  CheckboxGroupField,
  NumberField,
  SubmitButton,
  TextField,
} from "@/components/shared/form-fields";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { useTableState } from "@/hooks/use-table-state";
import { api, qk } from "@/lib/api";
import type { SmppAccount } from "@/lib/api/types";
import { formatDateTime, formatRelative } from "@/lib/format";
import { smppPasswordSchema } from "@/lib/validation";
import { Panel } from "./panel";

const BIND_OPTIONS = [
  { value: "TX", label: "TX" },
  { value: "RX", label: "RX" },
  { value: "TRX", label: "TRX" },
];

const settingsShape = {
  max_binds: z.number({ invalid_type_error: "Required" }).int().min(1, "≥ 1").max(100),
  max_tps: z.number().int().positive("Must be > 0").nullable(),
  allowed_bind_types: z.array(z.enum(["TX", "RX", "TRX"])).min(1, "Pick at least one"),
};

const createSchema = z.object({
  system_id: z
    .string()
    .trim()
    .min(1, "Required")
    .max(15, "Max 15 characters")
    .regex(/^[A-Za-z0-9_.-]+$/, "Letters, digits, _ . - only"),
  password: smppPasswordSchema,
  ...settingsShape,
});
const editSchema = z.object(settingsShape);
const passwordSchema = z.object({ password: smppPasswordSchema });

type CreateValues = z.input<typeof createSchema>;
type EditValues = z.input<typeof editSchema>;

function CreateDialog({ open, onOpenChange, orgId }: { open: boolean; onOpenChange: (v: boolean) => void; orgId?: string }) {
  const form = useForm<CreateValues, unknown, z.output<typeof createSchema>>({
    resolver: zodResolver(createSchema),
    defaultValues: { system_id: "", password: "", max_binds: 2, max_tps: null, allowed_bind_types: ["TX", "TRX"] },
  });
  const create = useApiMutation({
    mutationFn: (v: z.output<typeof createSchema>) =>
      api.smppAccounts.create(
        { system_id: v.system_id, password: v.password, max_binds: v.max_binds, max_tps: v.max_tps, allowed_bind_types: v.allowed_bind_types },
        { org_id: orgId },
      ),
    success: (a) => `SMPP account ${a.system_id} created`,
    invalidate: [qk.smppAccounts.all, qk.orgs.all],
    onSuccess: () => {
      onOpenChange(false);
      form.reset();
    },
  });
  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) form.reset(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New SMPP account</DialogTitle>
          <DialogDescription>Credentials a client uses to bind to the gateway on port 2775.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="space-y-4" noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField control={form.control} name="system_id" label="System ID" mono autoComplete="off" />
              <TextField
                control={form.control}
                name="password"
                label="Password"
                type="password"
                autoComplete="new-password"
                description="Max 8 characters (SMPP 3.4)."
              />
              <NumberField control={form.control} name="max_binds" label="Max binds" min={1} />
              <NumberField control={form.control} name="max_tps" label="Max TPS" placeholder="Org default" min={1} />
            </div>
            <CheckboxGroupField control={form.control} name="allowed_bind_types" label="Allowed bind types" options={BIND_OPTIONS} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <SubmitButton pending={create.isPending}>Create</SubmitButton>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({ account, onClose }: { account: SmppAccount | null; onClose: () => void }) {
  const form = useForm<EditValues, unknown, z.output<typeof editSchema>>({ resolver: zodResolver(editSchema) });
  useEffect(() => {
    if (account) {
      form.reset({
        max_binds: account.max_binds,
        max_tps: account.max_tps,
        allowed_bind_types: account.allowed_bind_types,
      });
    }
  }, [account, form]);
  const save = useApiMutation({
    mutationFn: (v: z.output<typeof editSchema>) => api.smppAccounts.update((account as SmppAccount).id, v),
    success: "SMPP account updated",
    invalidate: [qk.smppAccounts.all],
    onSuccess: onClose,
  });
  return (
    <Dialog open={!!account} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {account?.system_id}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-4" noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField control={form.control} name="max_binds" label="Max binds" min={1} />
              <NumberField control={form.control} name="max_tps" label="Max TPS" placeholder="Org default" min={1} />
            </div>
            <CheckboxGroupField control={form.control} name="allowed_bind_types" label="Allowed bind types" options={BIND_OPTIONS} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <SubmitButton pending={save.isPending}>Save</SubmitButton>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function PasswordDialog({ account, onClose }: { account: SmppAccount | null; onClose: () => void }) {
  const form = useForm<z.infer<typeof passwordSchema>>({ resolver: zodResolver(passwordSchema), defaultValues: { password: "" } });
  const save = useApiMutation({
    mutationFn: (v: z.infer<typeof passwordSchema>) => api.smppAccounts.setPassword((account as SmppAccount).id, v),
    success: "Password changed — active sessions were disconnected",
    invalidate: [qk.smppAccounts.all],
    onSuccess: () => {
      form.reset();
      onClose();
    },
  });
  return (
    <Dialog open={!!account} onOpenChange={(v) => { if (!v) { form.reset(); onClose(); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change password for {account?.system_id}</DialogTitle>
          <DialogDescription>All bound sessions of this account are disconnected.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-4" noValidate>
            <TextField control={form.control} name="password" label="New password" type="password" autoComplete="new-password" description="Max 8 characters." />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <SubmitButton pending={save.isPending}>Change password</SubmitButton>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export function SmppAccountsPanel({ orgId }: { orgId?: string }) {
  const t = useTableState({ prefix: "smpp", defaultPageSize: 10 });
  const params = { ...t.params, org_id: orgId };
  const q = useQuery({
    queryKey: qk.smppAccounts.list(params),
    queryFn: () => api.smppAccounts.list(params),
    placeholderData: keepPreviousData,
  });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<SmppAccount | null>(null);
  const [pwd, setPwd] = useState<SmppAccount | null>(null);
  const [deleting, setDeleting] = useState<SmppAccount | null>(null);

  const toggle = useApiMutation({
    mutationFn: (v: { a: SmppAccount; enabled: boolean }) => api.smppAccounts.update(v.a.id, { enabled: v.enabled }),
    success: (_d, v) => `${v.a.system_id} ${v.enabled ? "enabled" : "disabled"}`,
    invalidate: [qk.smppAccounts.all],
  });
  const remove = useApiMutation({
    mutationFn: (a: SmppAccount) => api.smppAccounts.remove(a.id),
    success: "SMPP account deleted",
    invalidate: [qk.smppAccounts.all, qk.orgs.all],
  });

  const columns: Column<SmppAccount>[] = [
    { id: "system_id", header: "System ID", cell: (a) => <code className="font-mono text-sm">{a.system_id}</code> },
    {
      id: "enabled",
      header: "Enabled",
      cell: (a) => (
        <Switch
          checked={a.enabled}
          onCheckedChange={(v) => toggle.mutate({ a, enabled: v })}
          aria-label={`Enable ${a.system_id}`}
        />
      ),
    },
    { id: "binds", header: "Binds", hideOnMobile: true, cell: (a) => `${a.allowed_bind_types.join("/")} · max ${a.max_binds}` },
    { id: "max_tps", header: "TPS", hideOnMobile: true, cell: (a) => a.max_tps ?? "Org default" },
    {
      id: "last_bind_at",
      header: "Last bind",
      hideOnMobile: true,
      cell: (a) => (
        <span title={formatDateTime(a.last_bind_at)}>
          {formatRelative(a.last_bind_at)}
          {a.last_bind_ip ? <span className="ml-1 text-xs text-muted-foreground">from {a.last_bind_ip}</span> : null}
        </span>
      ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (a) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={`Actions for ${a.system_id}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setEditing(a)}>
              <Pencil className="mr-2 h-4 w-4" /> Edit
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setPwd(a)}>
              <KeyRound className="mr-2 h-4 w-4" /> Change password
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive" onSelect={() => setDeleting(a)}>
              <Trash2 className="mr-2 h-4 w-4" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <Panel
      title="SMPP accounts"
      description="system_id / password pairs for binding over SMPP 3.4."
      action={
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus /> New account
        </Button>
      }
    >
      <DataTable
        caption="SMPP accounts"
        columns={columns}
        data={q.data}
        rowKey={(a) => a.id}
        isLoading={q.isLoading}
        isFetching={q.isFetching}
        error={q.error}
        onRetry={() => q.refetch()}
        state={t.state}
        onStateChange={t.setState}
        empty={{ title: "No SMPP accounts" }}
      />
      <CreateDialog open={creating} onOpenChange={setCreating} orgId={orgId} />
      <EditDialog account={editing} onClose={() => setEditing(null)} />
      <PasswordDialog account={pwd} onClose={() => setPwd(null)} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title={`Delete ${deleting?.system_id}?`}
        description="Bound sessions are disconnected and the system_id can no longer bind."
        confirmLabel="Delete"
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting);
        }}
      />
    </Panel>
  );
}

