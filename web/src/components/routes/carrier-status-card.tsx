"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, Pencil } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";
import { NumberField, SubmitButton, TextField } from "@/components/shared/form-fields";
import { EmptyState, ErrorState } from "@/components/shared/states";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { api, qk } from "@/lib/api";
import type { RouteConnectionStatus } from "@/lib/api/types";
import { connectionStateView, describeConnectionError } from "@/lib/carrier-status";
import { formatDateTime, formatRelative } from "@/lib/format";
import { connectionEndpointSchema, priorityLabel, toEndpointPatch, type ConnectionEndpointValues } from "@/lib/quick-route";
import { cn } from "@/lib/utils";

const DOT: Record<string, string> = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground/50",
};

function EditEndpointDialog({ conn, onClose }: { conn: RouteConnectionStatus | null; onClose: () => void }) {
  const form = useForm<ConnectionEndpointValues>({
    resolver: zodResolver(connectionEndpointSchema),
    defaultValues: { host: "", port: 2775, system_id: "", password: "" },
  });
  useEffect(() => {
    if (conn) form.reset({ host: conn.host, port: conn.port, system_id: conn.system_id, password: "" });
  }, [conn, form]);
  const save = useApiMutation({
    mutationFn: (v: ConnectionEndpointValues) => api.connections.update((conn as RouteConnectionStatus).connection_id, toEndpointPatch(v, conn as RouteConnectionStatus)),
    success: "Connection saved; it reconnects now",
    invalidate: [qk.routes.all, qk.connections.all],
    onSuccess: onClose,
  });
  return (
    <Dialog open={conn !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {conn?.connection_name}</DialogTitle>
          <DialogDescription>Changing these reconnects the carrier. Other routes using this connection are affected too.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((v) => {
              if (conn && Object.keys(toEndpointPatch(v, conn)).length === 0) return onClose();
              save.mutate(v);
            })}
            className="space-y-4"
            noValidate
          >
            <div className="grid gap-4 sm:grid-cols-3">
              <TextField control={form.control} name="host" label="Host / IP" mono className="sm:col-span-2" />
              <NumberField control={form.control} name="port" label="Port" min={1} max={65535} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField control={form.control} name="system_id" label="Username (system_id)" mono autoComplete="off" />
              <TextField
                control={form.control}
                name="password"
                label="Password"
                type="password"
                autoComplete="new-password"
                description="Leave blank to keep the current one."
              />
            </div>
            <div className="flex justify-end">
              <SubmitButton pending={save.isPending}>Save &amp; reconnect</SubmitButton>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/** Live per-connection state of one route (GET /api/routes/:id/status, every 3s). */
export function CarrierStatusCard({ routeId }: { routeId: string }) {
  const q = useQuery({
    queryKey: qk.routes.status(routeId),
    queryFn: ({ signal }) => api.routes.status(routeId, signal),
    refetchInterval: 3000,
    refetchIntervalInBackground: false,
  });
  const [editing, setEditing] = useState<RouteConnectionStatus | null>(null);
  const data = q.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Carrier status</CardTitle>
        <CardDescription>Live connection state from the engine, refreshed every 3 seconds.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3" aria-live="polite">
        {q.isError && !data ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !data ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : data.connections.length === 0 ? (
          <EmptyState title="No connections" description="Add a connection below; the route rejects traffic until one is bound." />
        ) : (
          <>
            {!data.engine_reachable ? (
              <p className="flex items-start gap-2 text-sm text-warning">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> The engine is not reachable, so the live state is unknown.
              </p>
            ) : null}
            <ul className="divide-y rounded-md border">
              {data.connections.map((c, i) => {
                const view = connectionStateView(c.state);
                const problem = c.state === "DOWN" || c.state === "CONNECTING" ? describeConnectionError(c.last_error, c) : null;
                return (
                  <li key={c.connection_id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start">
                    <span className={cn("mt-1.5 hidden h-2.5 w-2.5 shrink-0 rounded-full sm:block", DOT[view.tone])} aria-hidden />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{c.connection_name}</span>
                        <span className="text-xs text-muted-foreground">
                          {c.priority} · {priorityLabel(i)}
                          {!c.enabled ? " · off on this route" : ""}
                        </span>
                        <Badge variant={view.tone}>{view.label}</Badge>
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {c.system_id}@{c.host}:{c.port}
                        {c.use_tls ? " (TLS)" : ""}
                        {c.sessions_total > 1 ? ` · ${c.sessions_bound}/${c.sessions_total} sessions` : ""}
                      </div>
                      {c.state === "BOUND" && c.bound_since ? (
                        <div className="text-sm text-success" title={formatDateTime(c.bound_since)}>
                          Bound since {formatRelative(c.bound_since)}
                        </div>
                      ) : null}
                      {problem ? (
                        <div className={cn("text-sm", c.state === "DOWN" ? "text-destructive" : "text-warning")}>
                          {problem}
                          {problem !== c.last_error ? (
                            <span className="block font-mono text-xs text-muted-foreground">{c.last_error}</span>
                          ) : null}
                        </div>
                      ) : c.state === "CONNECTING" ? (
                        <div className="text-sm text-warning">Connecting…</div>
                      ) : c.state === "DOWN" ? (
                        <div className="text-sm text-destructive">Not connected</div>
                      ) : c.state === "UNKNOWN" && data.engine_reachable ? (
                        <div className="text-sm text-muted-foreground">Starting. The engine picks up new connections within a few seconds.</div>
                      ) : null}
                    </div>
                    <div className="flex gap-1">
                      <Button type="button" variant="outline" size="sm" onClick={() => setEditing(c)}>
                        <Pencil /> Edit
                      </Button>
                      <Button variant="ghost" size="icon" asChild>
                        <Link href={`/connections/${c.connection_id}`} aria-label={`Open connection ${c.connection_name}`}>
                          <ExternalLink />
                        </Link>
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </CardContent>
      <EditEndpointDialog conn={editing} onClose={() => setEditing(null)} />
    </Card>
  );
}
