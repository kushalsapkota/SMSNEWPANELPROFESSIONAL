"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Check, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
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
import { SelectField, SubmitButton, TextareaField } from "@/components/shared/form-fields";
import { PageHeader } from "@/components/shared/page-header";
import { StatusBadge } from "@/components/shared/status-badge";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { useTabParam } from "@/hooks/use-tab-param";
import { useTableState } from "@/hooks/use-table-state";
import { api, qk } from "@/lib/api";
import type { ApprovedContent, ContentStatus } from "@/lib/api/types";
import { useSession } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";

const STATUS_OPTIONS = [
  { value: "PENDING", label: "Pending" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
];

/** A truncated, hover-full preview of a message body for table cells. */
function ContentPreview({ text }: { text: string }) {
  return (
    <span className="line-clamp-2 max-w-md whitespace-pre-wrap break-words text-sm" title={text}>
      {text}
    </span>
  );
}

const adminAddSchema = z.object({
  org_id: z.string().uuid("Choose an account"),
  content: z.string().trim().min(1, "Content is required").max(2000),
});

/** Admin-only: set approved content directly for a chosen client (auto-approved). */
function AdminAddContentDialog() {
  const [open, setOpen] = useState(false);
  const clients = useQuery({
    queryKey: qk.orgs.list({ role: "CLIENT", page_size: 200 }),
    queryFn: () => api.orgs.list({ role: "CLIENT", page_size: 200 }),
    staleTime: 60_000,
  });
  const options = (clients.data?.items ?? []).map((o) => ({ value: o.id, label: o.name }));
  const form = useForm<z.infer<typeof adminAddSchema>>({
    resolver: zodResolver(adminAddSchema),
    defaultValues: { org_id: "", content: "" },
  });
  const create = useApiMutation({
    mutationFn: (v: z.infer<typeof adminAddSchema>) => api.approvedContent.create({ content: v.content }, { org_id: v.org_id }),
    success: "Content approved for the account",
    invalidate: [qk.approvedContent.all],
    onSuccess: () => {
      setOpen(false);
      form.reset();
    },
  });
  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) form.reset(); }}>
      <Button onClick={() => setOpen(true)}>
        <Plus /> Add content
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add approved content</DialogTitle>
          <DialogDescription>Set message content for an account. It&apos;s approved immediately.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="space-y-4" noValidate>
            <SelectField
              control={form.control}
              name="org_id"
              label="Account"
              options={options}
              placeholder={clients.isLoading ? "Loading accounts…" : "Choose a client…"}
            />
            <TextareaField
              control={form.control}
              name="content"
              label="Message content"
              rows={5}
              placeholder="The exact message text to allow…"
              description="Matching ignores case and extra spacing. Up to 2000 characters."
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton pending={create.isPending}>Add &amp; approve</SubmitButton>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The review queue. SUPER_ADMIN sees every org's content and can approve/reject;
 * a RESELLER sees its clients' content read-only (only an admin may approve).
 */
function ReviewTable({ canReview }: { canReview: boolean }) {
  const t = useTableState({ filters: ["status", "q"] as const, defaultPageSize: 25, prefix: "ap" });
  const status = (t.filters.status ?? "PENDING") as ContentStatus | "ALL";
  const params = {
    ...t.params,
    include_children: true,
    status: status === "ALL" ? undefined : status,
  };
  const q = useQuery({
    queryKey: qk.approvedContent.list(params),
    queryFn: () => api.approvedContent.list(params),
    placeholderData: keepPreviousData,
  });
  const [rejecting, setRejecting] = useState<ApprovedContent | null>(null);
  const approve = useApiMutation({
    mutationFn: (c: ApprovedContent) => api.approvedContent.approve(c.id),
    success: "Content approved",
    invalidate: [qk.approvedContent.all],
  });
  const reject = useApiMutation({
    mutationFn: (c: ApprovedContent) => api.approvedContent.reject(c.id),
    success: "Content rejected",
    invalidate: [qk.approvedContent.all],
  });

  const columns: Column<ApprovedContent>[] = [
    { id: "content", header: "Content", cell: (c) => <ContentPreview text={c.content} /> },
    { id: "org", header: "Account", cell: (c) => c.org_name ?? c.org_id.slice(0, 8) },
    { id: "status", header: "Status", cell: (c) => <StatusBadge status={c.status} /> },
    { id: "created_at", header: "Submitted", hideOnMobile: true, cell: (c) => formatDateTime(c.created_at) },
    ...(canReview
      ? [
          {
            id: "actions",
            header: <span className="sr-only">Actions</span>,
            align: "right" as const,
            cell: (c: ApprovedContent) => (
              <div className="flex justify-end gap-1">
                {c.status !== "APPROVED" ? (
                  <Button size="sm" variant="outline" onClick={() => approve.mutate(c)} disabled={approve.isPending}>
                    <Check /> Approve
                  </Button>
                ) : null}
                {c.status !== "REJECTED" ? (
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setRejecting(c)}>
                    <X /> Reject
                  </Button>
                ) : null}
              </div>
            ),
          },
        ]
      : []),
  ];

  return (
    <>
      <DataTable
        caption="Content approvals"
        columns={columns}
        data={q.data}
        rowKey={(c) => c.id}
        isLoading={q.isLoading}
        isFetching={q.isFetching}
        error={q.error}
        onRetry={() => q.refetch()}
        state={t.state}
        onStateChange={t.setState}
        empty={{ title: status === "PENDING" ? "Nothing waiting for approval" : "No content" }}
        toolbar={
          <>
            <SearchFilter value={t.filters.q} onChange={(v) => t.setFilter("q", v)} placeholder="Search account…" />
            <SelectFilter
              label="Status"
              allLabel="All statuses"
              value={status === "ALL" ? undefined : status}
              onChange={(v) => t.setFilter("status", v ?? "ALL")}
              options={STATUS_OPTIONS}
            />
            <ResetFiltersButton visible={!!t.filters.q || !!t.filters.status} onClick={t.resetFilters} />
            {canReview ? (
              <div className="ml-auto">
                <AdminAddContentDialog />
              </div>
            ) : null}
          </>
        }
      />
      <ConfirmDialog
        open={!!rejecting}
        onOpenChange={(v) => !v && setRejecting(null)}
        title="Reject this content?"
        description="The account will not be able to send this message while content approval is on."
        confirmLabel="Reject"
        onConfirm={async () => {
          if (rejecting) await reject.mutateAsync(rejecting);
        }}
      />
    </>
  );
}

const requestSchema = z.object({ content: z.string().trim().min(1, "Content is required").max(2000) });

/** The acting org's own submitted content + a submit form. */
function MyContent() {
  const t = useTableState({ filters: ["status"] as const, prefix: "my" });
  const params = { ...t.params, status: t.filters.status as ContentStatus | undefined };
  const q = useQuery({
    queryKey: qk.approvedContent.list(params),
    queryFn: () => api.approvedContent.list(params),
    placeholderData: keepPreviousData,
  });
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<ApprovedContent | null>(null);
  const form = useForm<z.infer<typeof requestSchema>>({
    resolver: zodResolver(requestSchema),
    defaultValues: { content: "" },
  });
  const create = useApiMutation({
    mutationFn: (v: z.infer<typeof requestSchema>) => api.approvedContent.create({ content: v.content }),
    success: "Content submitted — waiting for approval",
    invalidate: [qk.approvedContent.all],
    onSuccess: () => {
      setOpen(false);
      form.reset();
    },
  });
  const remove = useApiMutation({
    mutationFn: (c: ApprovedContent) => api.approvedContent.remove(c.id),
    success: "Content removed",
    invalidate: [qk.approvedContent.all],
  });

  const columns: Column<ApprovedContent>[] = [
    { id: "content", header: "Content", cell: (c) => <ContentPreview text={c.content} /> },
    { id: "status", header: "Status", cell: (c) => <StatusBadge status={c.status} /> },
    { id: "reviewed_at", header: "Reviewed", hideOnMobile: true, cell: (c) => formatDateTime(c.reviewed_at) },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (c) => (
        <Button variant="ghost" size="icon" aria-label="Remove content" onClick={() => setDeleting(c)}>
          <Trash2 />
        </Button>
      ),
    },
  ];

  return (
    <>
      <DataTable
        caption="My content"
        columns={columns}
        data={q.data}
        rowKey={(c) => c.id}
        isLoading={q.isLoading}
        isFetching={q.isFetching}
        error={q.error}
        onRetry={() => q.refetch()}
        state={t.state}
        onStateChange={t.setState}
        empty={{
          title: "No content submitted",
          description: "When content approval is on for your account, only messages matching an approved entry are sent.",
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
                <Plus /> Submit content
              </Button>
            </div>
          </>
        }
      />
      <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) form.reset(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Submit content for approval</DialogTitle>
            <DialogDescription>An administrator reviews the message before it can be sent.</DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="space-y-4" noValidate>
              <TextareaField
                control={form.control}
                name="content"
                label="Message content"
                rows={5}
                placeholder="The exact message text to allow…"
                description="Matching ignores case and extra spacing. Up to 2000 characters."
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <SubmitButton pending={create.isPending}>Submit</SubmitButton>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title="Remove this content?"
        description="If content approval is on, messages matching it will be rejected (CONTENT_NOT_APPROVED)."
        confirmLabel="Remove"
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting);
        }}
      />
    </>
  );
}

export function ApprovedContentPage() {
  const { role } = useSession();
  const [tab, setTab] = useTabParam(["approvals", "mine"] as const, "approvals");

  if (role === "CLIENT") {
    return (
      <>
        <PageHeader title="Approved content" description="Message content you're allowed to send when content approval is on." />
        <MyContent />
      </>
    );
  }
  if (role === "SUPER_ADMIN") {
    return (
      <>
        <PageHeader title="Approved content" description="Review and approve the message content clients may send." />
        <ReviewTable canReview />
      </>
    );
  }
  // RESELLER: can watch its clients' content (read-only) and submit its own.
  return (
    <>
      <PageHeader title="Approved content" description="Your clients' content (an administrator approves it) and your own." />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="approvals">Client content</TabsTrigger>
          <TabsTrigger value="mine">My content</TabsTrigger>
        </TabsList>
        <TabsContent value="approvals" className="mt-4">
          <ReviewTable canReview={false} />
        </TabsContent>
        <TabsContent value="mine" className="mt-4">
          <MyContent />
        </TabsContent>
      </Tabs>
    </>
  );
}
