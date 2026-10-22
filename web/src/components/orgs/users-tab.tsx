"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { KeyRound, MoreHorizontal, Plus, Trash2, UserCheck, UserX } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Form } from "@/components/ui/form";
import { DataTable, type Column } from "@/components/data-table";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { SubmitButton, TextField } from "@/components/shared/form-fields";
import { BoolBadge } from "@/components/shared/status-badge";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { useTableState } from "@/hooks/use-table-state";
import { api, qk } from "@/lib/api";
import type { OrgDetail, User } from "@/lib/api/types";
import { formatDateTime, formatRelative } from "@/lib/format";
import { emailSchema, passwordSchema } from "@/lib/validation";

const createSchema = z.object({
  full_name: z.string().trim().min(1, "Required").max(200),
  email: emailSchema,
  password: passwordSchema,
});

function CreateUserDialog({ orgId, open, onOpenChange }: { orgId: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const form = useForm<z.infer<typeof createSchema>>({
    resolver: zodResolver(createSchema),
    defaultValues: { full_name: "", email: "", password: "" },
  });
  const create = useApiMutation({
    mutationFn: (v: z.infer<typeof createSchema>) => api.orgs.createUser(orgId, v),
    success: (u) => `User ${u.email} created`,
    invalidate: [qk.orgs.users(orgId), qk.orgs.detail(orgId)],
    onSuccess: () => {
      onOpenChange(false);
      form.reset();
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) form.reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add user</DialogTitle>
          <DialogDescription>The user can sign in to this organization&apos;s panel.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="space-y-4" noValidate>
            <TextField control={form.control} name="full_name" label="Full name" />
            <TextField control={form.control} name="email" label="Email" type="email" autoComplete="off" />
            <TextField
              control={form.control}
              name="password"
              label="Initial password"
              type="password"
              autoComplete="new-password"
              description="At least 8 characters. Ask the user to change it after first login."
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <SubmitButton pending={create.isPending}>Add user</SubmitButton>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

const resetSchema = z
  .object({ new_password: passwordSchema, confirm: z.string() })
  .refine((v) => v.new_password === v.confirm, { path: ["confirm"], message: "Passwords don't match" });

function ResetPasswordDialog({ orgId, user, onClose }: { orgId: string; user: User | null; onClose: () => void }) {
  const form = useForm<z.infer<typeof resetSchema>>({
    resolver: zodResolver(resetSchema),
    defaultValues: { new_password: "", confirm: "" },
  });
  const reset = useApiMutation({
    mutationFn: (v: z.infer<typeof resetSchema>) =>
      api.orgs.resetUserPassword(orgId, (user as User).id, { new_password: v.new_password }),
    success: "Password reset — the user's sessions were signed out",
    invalidate: [qk.orgs.users(orgId), qk.auditLogs.all],
    onSuccess: () => {
      form.reset();
      onClose();
    },
  });
  return (
    <Dialog
      open={!!user}
      onOpenChange={(v) => {
        if (!v) {
          form.reset();
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset password</DialogTitle>
          <DialogDescription>Set a new password for {user?.email}.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((v) => reset.mutate(v))} className="space-y-4" noValidate>
            <TextField control={form.control} name="new_password" label="New password" type="password" autoComplete="new-password" />
            <TextField control={form.control} name="confirm" label="Confirm password" type="password" autoComplete="new-password" />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <SubmitButton pending={reset.isPending}>Reset password</SubmitButton>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export function UsersTab({ org }: { org: OrgDetail }) {
  const t = useTableState({ prefix: "u", defaultPageSize: 25 });
  const q = useQuery({
    queryKey: qk.orgs.users(org.id, t.params),
    queryFn: () => api.orgs.users(org.id, t.params),
    placeholderData: keepPreviousData,
  });
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<User | null>(null);
  const [toggling, setToggling] = useState<User | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);

  const setActive = useApiMutation({
    mutationFn: (v: { user: User; is_active: boolean }) => api.orgs.updateUser(org.id, v.user.id, { is_active: v.is_active }),
    success: (_d, v) => (v.is_active ? `${v.user.email} reactivated` : `${v.user.email} deactivated`),
    invalidate: [qk.orgs.users(org.id), qk.auditLogs.all],
  });
  const del = useApiMutation({
    mutationFn: (u: User) => api.orgs.deleteUser(org.id, u.id),
    success: (_d, u) => `${u.email} deleted`,
    invalidate: [qk.orgs.users(org.id), qk.orgs.detail(org.id), qk.auditLogs.all],
  });

  const columns: Column<User>[] = [
    {
      id: "email",
      header: "User",
     
      cell: (u) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{u.full_name || u.email}</div>
          {u.full_name ? <div className="truncate text-xs text-muted-foreground">{u.email}</div> : null}
        </div>
      ),
    },
    { id: "is_active", header: "Status", cell: (u) => <BoolBadge value={u.is_active} on="Active" off="Deactivated" /> },
    {
      id: "totp_enabled",
      header: "2FA",
      hideOnMobile: true,
      cell: (u) => (u.totp_enabled ? <Badge variant="success">On</Badge> : <Badge variant="muted">Off</Badge>),
    },
    {
      id: "last_login_at",
      header: "Last login",
     
      hideOnMobile: true,
      cell: (u) => <span title={formatDateTime(u.last_login_at)}>{formatRelative(u.last_login_at)}</span>,
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (u) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={`Actions for ${u.email}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setResetting(u)}>
              <KeyRound className="mr-2 h-4 w-4" /> Reset password
            </DropdownMenuItem>
            {u.is_active ? (
              <DropdownMenuItem className="text-destructive" onSelect={() => setToggling(u)}>
                <UserX className="mr-2 h-4 w-4" /> Deactivate
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => setActive.mutate({ user: u, is_active: true })}>
                <UserCheck className="mr-2 h-4 w-4" /> Reactivate
              </DropdownMenuItem>
            )}
            <DropdownMenuItem className="text-destructive" onSelect={() => setDeleting(u)}>
              <Trash2 className="mr-2 h-4 w-4" /> Delete user
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Users</CardTitle>
          <CardDescription>Panel logins for this organization.</CardDescription>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus /> Add user
        </Button>
      </CardHeader>
      <CardContent>
        <DataTable
          caption="Users"
          columns={columns}
          data={q.data}
          rowKey={(u) => u.id}
          isLoading={q.isLoading}
          isFetching={q.isFetching}
          error={q.error}
          onRetry={() => q.refetch()}
          state={t.state}
          onStateChange={t.setState}
          empty={{ title: "No users" }}
        />
      </CardContent>
      <CreateUserDialog orgId={org.id} open={creating} onOpenChange={setCreating} />
      <ResetPasswordDialog orgId={org.id} user={resetting} onClose={() => setResetting(null)} />
      <ConfirmDialog
        open={!!toggling}
        onOpenChange={(v) => !v && setToggling(null)}
        title={`Deactivate ${toggling?.email}?`}
        description="The user is signed out everywhere and can no longer log in. You can reactivate them later."
        confirmLabel="Deactivate"
        onConfirm={async () => {
          if (toggling) await setActive.mutateAsync({ user: toggling, is_active: false });
        }}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title={`Delete ${deleting?.email}?`}
        description="Permanently removes this user and signs them out everywhere. This can't be undone. An organization's last remaining user can't be deleted — close the organization instead."
        confirmText={deleting?.email}
        confirmLabel="Delete user"
        onConfirm={async () => {
          if (deleting) await del.mutateAsync(deleting);
        }}
      />
    </Card>
  );
}
