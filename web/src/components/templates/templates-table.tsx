"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { DataTable, ResetFiltersButton, SelectFilter, type Column } from "@/components/data-table";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import type { Option } from "@/components/shared/form-fields";
import { humanize } from "@/components/shared/status-badge";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { useTableState } from "@/hooks/use-table-state";
import { api, qk } from "@/lib/api";
import type { RouteTemplate } from "@/lib/api/types";
import { useSession } from "@/lib/auth/session";
import { formatDate } from "@/lib/format";
import { TemplateEditorDialog } from "./template-editor";

/**
 * - SUPER_ADMIN: route-wide templates (org_id NULL) are editable; client
 *   overrides are listed read-only.
 * - RESELLER: per-client overrides; `clientId` fixes the client (client
 *   detail tab), otherwise a client picker/filter is shown.
 */
export function TemplatesTable({ clientId }: { clientId?: string }) {
  const { role } = useSession();
  const isAdmin = role === "SUPER_ADMIN";
  const t = useTableState({ filters: ["route_id", "org_id"] as const, prefix: clientId ? "tpl" : undefined });
  const params = { ...t.params, ...(clientId ? { org_id: clientId } : {}) };
  const q = useQuery({
    queryKey: qk.templates.list(params),
    queryFn: () => api.templates.list(params),
    placeholderData: keepPreviousData,
  });

  const adminRoutes = useQuery({
    queryKey: qk.routes.list({ page_size: 200 }),
    queryFn: () => api.routes.list({ page_size: 200 }),
    enabled: isAdmin,
  });
  const assignedRoutes = useQuery({
    queryKey: qk.routes.assigned({ page_size: 200 }),
    queryFn: () => api.routes.listAssigned({ page_size: 200 }),
    enabled: !isAdmin,
  });
  const clients = useQuery({
    queryKey: qk.orgs.list({ role: "CLIENT", page_size: 200 }),
    queryFn: () => api.orgs.list({ role: "CLIENT", page_size: 200 }),
    enabled: !isAdmin && !clientId,
  });

  const routeOptions: Option[] = useMemo(() => {
    const items = isAdmin ? adminRoutes.data?.items : assignedRoutes.data?.items;
    return (items ?? []).map((r) => ({
      value: r.id,
      label: r.template_mode ? r.name : `${r.name} (template mode off)`,
    }));
  }, [isAdmin, adminRoutes.data, assignedRoutes.data]);
  const routeName = (id: string) => routeOptions.find((r) => r.value === id)?.label ?? id.slice(0, 8);
  const clientOptions: Option[] = useMemo(
    () => (clients.data?.items ?? []).map((c) => ({ value: c.id, label: c.name })),
    [clients.data],
  );

  const [editor, setEditor] = useState<{ open: boolean; template: RouteTemplate | null }>({ open: false, template: null });
  const [deleting, setDeleting] = useState<RouteTemplate | null>(null);

  const canEdit = (tpl: RouteTemplate) => (isAdmin ? tpl.org_id === null : tpl.org_id !== null);

  const toggle = useApiMutation({
    mutationFn: (v: { tpl: RouteTemplate; is_active: boolean }) => api.templates.update(v.tpl.id, { is_active: v.is_active }),
    success: (_d, v) => `Template ${v.is_active ? "activated" : "deactivated"}`,
    invalidate: [qk.templates.all],
  });
  const remove = useApiMutation({
    mutationFn: (tpl: RouteTemplate) => api.templates.remove(tpl.id),
    success: "Template deleted",
    invalidate: [qk.templates.all],
  });

  const columns: Column<RouteTemplate>[] = [
    {
      id: "name",
      header: "Template",
      cell: (tpl) => (
        <div className="min-w-0 max-w-sm">
          <div className="font-medium">{tpl.name}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">{tpl.template_body}</div>
        </div>
      ),
    },
    { id: "route", header: "Route", cell: (tpl) => tpl.route_name ?? routeName(tpl.route_id) },
    {
      id: "scope",
      header: "Scope",
      hideOnMobile: !!clientId,
      cell: (tpl) =>
        tpl.org_id ? <Badge variant="secondary">{tpl.org_name ?? "Client override"}</Badge> : <Badge variant="outline">Route-wide</Badge>,
    },
    {
      id: "fallback",
      header: "Fallback",
      hideOnMobile: true,
      cell: (tpl) => (tpl.fallback_action ? humanize(tpl.fallback_action) : <span className="text-muted-foreground">Route default</span>),
    },
    {
      id: "is_active",
      header: "Active",
      cell: (tpl) => (
        <Switch
          checked={tpl.is_active}
          disabled={!canEdit(tpl) || toggle.isPending}
          onCheckedChange={(v) => toggle.mutate({ tpl, is_active: v })}
          aria-label={`Active: ${tpl.name}`}
        />
      ),
    },
    { id: "updated_at", header: "Updated", hideOnMobile: true, cell: (tpl) => formatDate(tpl.updated_at) },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (tpl) =>
        canEdit(tpl) ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={`Actions for ${tpl.name}`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setEditor({ open: true, template: tpl })}>
                <Pencil className="mr-2 h-4 w-4" /> Edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onSelect={() => setDeleting(tpl)}>
                <Trash2 className="mr-2 h-4 w-4" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null,
    },
  ];

  return (
    <>
      <DataTable
        caption="Templates"
        columns={columns}
        data={q.data}
        rowKey={(tpl) => tpl.id}
        isLoading={q.isLoading}
        isFetching={q.isFetching}
        error={q.error}
        onRetry={() => q.refetch()}
        state={t.state}
        onStateChange={t.setState}
        onRowClick={(tpl) => canEdit(tpl) && setEditor({ open: true, template: tpl })}
        empty={{
          title: "No templates",
          description: isAdmin
            ? "Route-wide templates rewrite OTP messages on routes with template mode on."
            : "Client overrides replace the route-wide template for one client.",
        }}
        toolbar={
          <>
            <SelectFilter
              label="Route"
              allLabel="All routes"
              value={t.filters.route_id}
              onChange={(v) => t.setFilter("route_id", v)}
              options={routeOptions}
            />
            {!isAdmin && !clientId ? (
              <SelectFilter
                label="Client"
                allLabel="All clients"
                value={t.filters.org_id}
                onChange={(v) => t.setFilter("org_id", v)}
                options={clientOptions}
              />
            ) : null}
            <ResetFiltersButton visible={!!(t.filters.route_id || t.filters.org_id)} onClick={t.resetFilters} />
            <div className="ml-auto">
              <Button onClick={() => setEditor({ open: true, template: null })} disabled={routeOptions.length === 0}>
                <Plus /> {isAdmin ? "New template" : "New override"}
              </Button>
            </div>
          </>
        }
      />
      <TemplateEditorDialog
        open={editor.open}
        template={editor.template}
        onClose={() => setEditor({ open: false, template: null })}
        routeOptions={routeOptions}
        defaultRouteId={t.filters.route_id}
        orgId={isAdmin ? null : (clientId ?? t.filters.org_id ?? null)}
        orgOptions={!isAdmin && !clientId ? clientOptions : undefined}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title={`Delete template “${deleting?.name}”?`}
        description={
          deleting?.org_id
            ? "The client falls back to the route-wide template."
            : "Messages on this route will use the route's fallback behaviour until another template is active."
        }
        confirmLabel="Delete"
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting);
        }}
      />
    </>
  );
}
