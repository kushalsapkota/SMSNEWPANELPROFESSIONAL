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
} from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataTable, ResetFiltersButton, SearchFilter, type Column } from "@/components/data-table";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { SelectField, SubmitButton, TextField } from "@/components/shared/form-fields";
import { PageHeader } from "@/components/shared/page-header";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { useChildOrgOptions } from "@/hooks/use-child-orgs";
import { useTabParam } from "@/hooks/use-tab-param";
import { useTableState } from "@/hooks/use-table-state";
import { api, qk } from "@/lib/api";
import type { BlockedKeyword, BlockedNumber, Paginated } from "@/lib/api/types";
import { useSession } from "@/lib/auth/session";
import { formatDate } from "@/lib/format";
import { stripPhone } from "@/lib/phone";
import { re2Schema } from "@/lib/validation";

type Kind = "numbers" | "keywords";

const numberSchema = z.object({
  value: z
    .string()
    .trim()
    .transform(stripPhone)
    .pipe(z.string().regex(/^[0-9]{1,15}$/, "1-15 digits (a full number blocks exactly that MSISDN)")),
  note: z.string().trim().max(200),
  org_id: z.string().nullable(),
});
const keywordSchema = z.object({
  value: z.string().trim().min(1, "Required").pipe(re2Schema),
  note: z.string().trim().max(200),
  org_id: z.string().nullable(),
});

function AddDialog({ kind, open, onOpenChange }: { kind: Kind; open: boolean; onOpenChange: (v: boolean) => void }) {
  const { role } = useSession();
  const isAdmin = role === "SUPER_ADMIN";
  const { options } = useChildOrgOptions(!isAdmin && open);
  const schema = kind === "numbers" ? numberSchema : keywordSchema;
  const form = useForm<z.input<typeof schema>, unknown, z.output<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { value: "", note: "", org_id: null },
  });
  const create = useApiMutation({
    mutationFn: (v: z.output<typeof schema>): Promise<BlockedNumber | BlockedKeyword> => {
      const scope = v.org_id ? { org_id: v.org_id } : {};
      return kind === "numbers"
        ? api.blocklist.createNumber({ prefix: v.value, note: v.note || undefined }, scope)
        : api.blocklist.createKeyword({ pattern: v.value, note: v.note || undefined }, scope);
    },
    success: kind === "numbers" ? "Number blocked" : "Keyword blocked",
    invalidate: [qk.blocklist.all],
    onSuccess: () => {
      onOpenChange(false);
      form.reset();
    },
  });
  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) form.reset(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{kind === "numbers" ? "Block number or prefix" : "Block keyword"}</DialogTitle>
          <DialogDescription>
            {kind === "numbers"
              ? "Messages to matching destinations are rejected with DESTINATION_BLOCKED."
              : "Messages whose text matches are rejected with CONTENT_BLOCKED (RE2, case-insensitive)."}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="space-y-4" noValidate>
            <TextField
              control={form.control}
              name="value"
              label={kind === "numbers" ? "Number / prefix" : "Pattern"}
              mono
              placeholder={kind === "numbers" ? "9198765 or 919876543210" : "(?i)lottery|casino"}
            />
            <TextField control={form.control} name="note" label="Note" />
            {!isAdmin ? (
              <SelectField
                control={form.control}
                name="org_id"
                label="Applies to"
                options={options}
                nullable
                noneLabel="All my clients"
              />
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <SubmitButton pending={create.isPending}>Block</SubmitButton>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function scopeBadge(orgId: string | null, orgName: string | null | undefined, myOrgId: string) {
  if (orgId === null) return <Badge variant="destructive">Global</Badge>;
  if (orgId === myOrgId) return <Badge variant="secondary">All my clients</Badge>;
  return <Badge variant="outline">{orgName ?? "Client"}</Badge>;
}

type Row = BlockedNumber | BlockedKeyword;

function BlockTable({ kind }: { kind: Kind }) {
  const { org } = useSession();
  const t = useTableState({ filters: ["q"] as const, prefix: kind });
  const q = useQuery({
    queryKey: kind === "numbers" ? qk.blocklist.numbers(t.params) : qk.blocklist.keywords(t.params),
    queryFn: (): Promise<Paginated<Row>> =>
      kind === "numbers" ? api.blocklist.numbers(t.params) : api.blocklist.keywords(t.params),
    placeholderData: keepPreviousData,
  });
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Row | null>(null);
  const remove = useApiMutation({
    mutationFn: (row: Row) => (kind === "numbers" ? api.blocklist.removeNumber(row.id) : api.blocklist.removeKeyword(row.id)),
    success: "Removed from blocklist",
    invalidate: [qk.blocklist.all],
  });
  const valueOf = (row: Row) => ("prefix" in row ? row.prefix : row.pattern);
  // Rows above the acting org (e.g. global rows seen by a reseller) are read-only.
  const canDelete = (row: Row) => org.role === "SUPER_ADMIN" || row.org_id !== null;

  const columns: Column<Row>[] = [
    {
      id: "value",
      header: kind === "numbers" ? "Number / prefix" : "Pattern",
      cell: (row) => <code className="break-all font-mono text-sm">{valueOf(row)}</code>,
    },
    { id: "scope", header: "Scope", cell: (row) => scopeBadge(row.org_id, row.org_name, org.id) },
    { id: "note", header: "Note", hideOnMobile: true, cell: (row) => row.note || "—" },
    { id: "created_at", header: "Added", hideOnMobile: true, cell: (row) => formatDate(row.created_at) },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (row) =>
        canDelete(row) ? (
          <Button variant="ghost" size="icon" aria-label={`Remove ${valueOf(row)}`} onClick={() => setRemoving(row)}>
            <Trash2 />
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <DataTable
        caption={kind === "numbers" ? "Blocked numbers" : "Blocked keywords"}
        columns={columns}
        data={q.data}
        rowKey={(row) => row.id}
        isLoading={q.isLoading}
        isFetching={q.isFetching}
        error={q.error}
        onRetry={() => q.refetch()}
        state={t.state}
        onStateChange={t.setState}
        empty={{ title: kind === "numbers" ? "No blocked numbers" : "No blocked keywords" }}
        toolbar={
          <>
            <SearchFilter value={t.filters.q} onChange={(v) => t.setFilter("q", v)} maxLength={20} />
            <ResetFiltersButton visible={!!t.filters.q} onClick={t.resetFilters} />
            <div className="ml-auto">
              <Button onClick={() => setAdding(true)}>
                <Plus /> {kind === "numbers" ? "Block number" : "Block keyword"}
              </Button>
            </div>
          </>
        }
      />
      <AddDialog kind={kind} open={adding} onOpenChange={setAdding} />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(v) => !v && setRemoving(null)}
        title="Remove from blocklist?"
        description={removing ? <code className="break-all">{valueOf(removing)}</code> : null}
        confirmLabel="Remove"
        onConfirm={async () => {
          if (removing) await remove.mutateAsync(removing);
        }}
      />
    </>
  );
}

export function BlocklistPage() {
  const { role } = useSession();
  const [tab, setTab] = useTabParam(["numbers", "keywords"] as const, "numbers");
  return (
    <>
      <PageHeader
        title="Blocklist"
        description={
          role === "SUPER_ADMIN"
            ? "Global blocks apply to every reseller and client."
            : "Blocks for all of your clients or a single client. Global blocks set by your provider also apply."
        }
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="numbers">Numbers</TabsTrigger>
          <TabsTrigger value="keywords">Keywords</TabsTrigger>
        </TabsList>
        <TabsContent value="numbers" className="mt-4">
          <BlockTable kind="numbers" />
        </TabsContent>
        <TabsContent value="keywords" className="mt-4">
          <BlockTable kind="keywords" />
        </TabsContent>
      </Tabs>
    </>
  );
}
