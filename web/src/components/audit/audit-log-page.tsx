"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DataTable,
  ResetFiltersButton,
  SearchFilter,
  SelectFilter,
  type Column,
} from "@/components/data-table";
import { PageHeader } from "@/components/shared/page-header";
import { useChildOrgOptions } from "@/hooks/use-child-orgs";
import { useTableState } from "@/hooks/use-table-state";
import { api, qk } from "@/lib/api";
import type { AuditLog, AuditLogParams } from "@/lib/api/types";
import { useSession } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";

function Json({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <p className="text-sm text-muted-foreground">—</p>;
  return (
    <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

/** Keys whose value differs between before/after. */
function changedKeys(a: Record<string, unknown> | null, b: Record<string, unknown> | null): string[] {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  return Array.from(keys).filter((k) => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]));
}

function AuditDetail({ entry, onClose }: { entry: AuditLog | null; onClose: () => void }) {
  const changed = entry ? changedKeys(entry.before, entry.after) : [];
  return (
    <Dialog open={!!entry} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-mono">{entry?.action}</DialogTitle>
          <DialogDescription>{entry ? formatDateTime(entry.created_at) : null}</DialogDescription>
        </DialogHeader>
        {entry ? (
          <div className="space-y-4 text-sm">
            <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">Actor</dt>
              <dd>
                {entry.actor_email ?? entry.actor_user_id ?? "system"}
                {entry.actor_org_name ? ` (${entry.actor_org_name})` : ""}
              </dd>
              {entry.impersonator_user_id ? (
                <>
                  <dt className="text-muted-foreground">Impersonated by</dt>
                  <dd>{entry.impersonator_email ?? entry.impersonator_user_id}</dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">Target</dt>
              <dd>{entry.target_org_name ?? entry.target_org_id ?? "—"}</dd>
              <dt className="text-muted-foreground">Entity</dt>
              <dd className="break-all">
                {entry.entity_type ?? "—"} {entry.entity_id ? <code className="text-xs">{entry.entity_id}</code> : null}
              </dd>
              <dt className="text-muted-foreground">IP</dt>
              <dd>{entry.ip ?? "—"}</dd>
              <dt className="text-muted-foreground">User agent</dt>
              <dd className="break-all text-xs">{entry.user_agent ?? "—"}</dd>
            </dl>
            {changed.length ? (
              <div className="flex flex-wrap gap-1">
                <span className="text-muted-foreground">Changed:</span>
                {changed.map((k) => (
                  <Badge key={k} variant="secondary" className="font-mono">
                    {k}
                  </Badge>
                ))}
              </div>
            ) : null}
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1">
                <h4 className="font-medium">Before</h4>
                <Json value={entry.before} />
              </div>
              <div className="space-y-1">
                <h4 className="font-medium">After</h4>
                <Json value={entry.after} />
              </div>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const columns: Column<AuditLog>[] = [
  { id: "created_at", header: "Time", cell: (e) => <span className="whitespace-nowrap">{formatDateTime(e.created_at)}</span> },
  {
    id: "actor",
    header: "Actor",
    cell: (e) => (
      <div className="min-w-0 max-w-[14rem]">
        <div className="truncate">{e.actor_email ?? (e.actor_user_id ? e.actor_user_id.slice(0, 8) : "system")}</div>
        {e.impersonator_user_id ? (
          <div className="truncate text-xs text-warning">via {e.impersonator_email ?? "impersonation"}</div>
        ) : e.actor_org_name ? (
          <div className="truncate text-xs text-muted-foreground">{e.actor_org_name}</div>
        ) : null}
      </div>
    ),
  },
  { id: "action", header: "Action", cell: (e) => <code className="text-sm">{e.action}</code> },
  { id: "target", header: "Target", hideOnMobile: true, cell: (e) => e.target_org_name ?? (e.target_org_id ? e.target_org_id.slice(0, 8) : "—") },
  { id: "ip", header: "IP", hideOnMobile: true, cell: (e) => <span className="font-mono text-xs">{e.ip ?? "—"}</span> },
];

/** Local YYYY-MM-DD → ISO instant at local midnight (+1 day for an inclusive "to"). */
function dayToIso(day: string, addDays = 0): string | undefined {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d + addDays).toISOString();
}

/** The api takes ISO datetimes and an exact action or `prefix*`; the UI searches by prefix. */
function toApiParams(p: { page: number; page_size: number; action?: string; org_id?: string; from?: string; to?: string }): AuditLogParams {
  const action = (p.action ?? "").toLowerCase().replace(/[^a-z_.*]/g, "").replace(/\*(?=.)/g, "");
  return {
    page: p.page,
    page_size: p.page_size,
    org_id: p.org_id,
    action: action ? (action.endsWith("*") ? action : `${action}*`) : undefined,
    from: p.from ? dayToIso(p.from) : undefined,
    to: p.to ? dayToIso(p.to, 1) : undefined,
  };
}

export function AuditLogPage() {
  const { role } = useSession();
  const t = useTableState({ filters: ["action", "org_id", "from", "to"] as const, defaultPageSize: 50 });
  const { options } = useChildOrgOptions();
  const params = toApiParams(t.params);
  const q = useQuery({
    queryKey: qk.auditLogs.list(params),
    queryFn: () => api.auditLogs.list(params),
    placeholderData: keepPreviousData,
  });
  const [selected, setSelected] = useState<AuditLog | null>(null);
  const hasFilters = !!(t.filters.action || t.filters.org_id || t.filters.from || t.filters.to);

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every management action, including those taken while impersonating. Append-only."
      />
      <DataTable
        caption="Audit log"
        columns={columns}
        data={q.data}
        rowKey={(e) => e.id}
        isLoading={q.isLoading}
        isFetching={q.isFetching}
        error={q.error}
        onRetry={() => q.refetch()}
        state={t.state}
        onStateChange={t.setState}
        onRowClick={setSelected}
        empty={{ title: "No audit entries", description: hasFilters ? "Try widening the filters." : undefined }}
        toolbar={
          <>
            <SearchFilter
              value={t.filters.action}
              onChange={(v) => t.setFilter("action", v)}
              placeholder="Action prefix, e.g. client."
              label="Action prefix"
            />
            <SelectFilter
              label={role === "SUPER_ADMIN" ? "Reseller" : "Client"}
              allLabel={role === "SUPER_ADMIN" ? "All organizations" : "All clients"}
              value={t.filters.org_id}
              onChange={(v) => t.setFilter("org_id", v)}
              options={options}
            />
            <div className="flex items-center gap-2">
              <Label htmlFor="audit-from" className="text-sm text-muted-foreground">
                From
              </Label>
              <Input
                id="audit-from"
                type="date"
                className="w-auto"
                value={t.filters.from ?? ""}
                onChange={(e) => t.setFilter("from", e.target.value || undefined)}
              />
              <Label htmlFor="audit-to" className="text-sm text-muted-foreground">
                To
              </Label>
              <Input
                id="audit-to"
                type="date"
                className="w-auto"
                value={t.filters.to ?? ""}
                onChange={(e) => t.setFilter("to", e.target.value || undefined)}
              />
            </div>
            <ResetFiltersButton visible={hasFilters} onClick={t.resetFilters} />
          </>
        }
      />
      <AuditDetail entry={selected} onClose={() => setSelected(null)} />
    </>
  );
}
