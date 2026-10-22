"use client";

import { useQuery } from "@tanstack/react-query";
import { Globe, Power, Radio, Send } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorState, FullPageSpinner } from "@/components/shared/states";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { api, qk } from "@/lib/api";
import type { ServiceSwitches, ServiceSwitchesUpdate } from "@/lib/api/types";

// The three channel switches shown under the master. `key` is the column the
// toggle writes; the master (all_enabled) is handled separately above.
type ChannelKey = "http_api_enabled" | "smpp_enabled" | "bulk_enabled";
const CHANNELS: Array<{ key: ChannelKey; label: string; icon: typeof Globe; desc: string }> = [
  {
    key: "http_api_enabled",
    label: "HTTP API",
    icon: Globe,
    desc: "Client sends over the HTTP API (/v1/sms/send). Off = those calls are rejected.",
  },
  {
    key: "smpp_enabled",
    label: "SMPP",
    icon: Radio,
    desc: "SMPP client binds and submits. Off = live binds are dropped and new binds refused.",
  },
  {
    key: "bulk_enabled",
    label: "Bulk sending",
    icon: Send,
    desc: "Campaigns and multi-recipient batches. Off = bulk is rejected; single sends still work.",
  },
];

export function SwitchesPage() {
  const q = useQuery({ queryKey: qk.switches.status, queryFn: () => api.switches.status() });

  if (q.isLoading) return <FullPageSpinner />;
  if (q.isError || !q.data) {
    return (
      <>
        <PageHeader title="Kill switch" description="Turn services on or off for the whole gateway." />
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      </>
    );
  }
  return <SwitchesEditor data={q.data} />;
}

function SwitchesEditor({ data }: { data: ServiceSwitches }) {
  // A pending OFF flip waiting for confirmation (turning something back ON is immediate).
  const [pending, setPending] = useState<{ patch: ServiceSwitchesUpdate; label: string; title: string; body: ReactNode } | null>(null);

  const mutate = useApiMutation<ServiceSwitches, { patch: ServiceSwitchesUpdate; label: string; on: boolean }>({
    mutationFn: (v) => api.switches.update(v.patch),
    success: (_d, v) => `${v.label} ${v.on ? "enabled" : "disabled"}`,
    invalidate: [qk.switches.all, qk.auditLogs.all],
  });

  const allOn = data.all_enabled;

  // Turning something ON is safe → apply immediately. Turning OFF → confirm first.
  const flip = (patch: ServiceSwitchesUpdate, label: string, on: boolean, confirm: { title: string; body: ReactNode }) => {
    if (on) {
      mutate.mutate({ patch, label, on: true });
    } else {
      setPending({ patch, label, title: confirm.title, body: confirm.body });
    }
  };

  const updatedAt = data.updated_at ? new Date(data.updated_at) : null;

  return (
    <>
      <PageHeader
        title="Kill switch"
        description="Stop services across the whole gateway with one click. Admin only. Changes apply live within a few seconds — no restart."
      />

      {/* Master switch */}
      <Card className={allOn ? "mb-4" : "mb-4 border-destructive/50 bg-destructive/5"}>
        <CardContent className="flex flex-wrap items-center justify-between gap-4 py-5">
          <div className="flex items-center gap-3">
            <Power className={allOn ? "h-6 w-6 text-emerald-500" : "h-6 w-6 text-destructive"} aria-hidden />
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold">All services</span>
                {allOn ? (
                  <Badge variant="success">Running</Badge>
                ) : (
                  <Badge variant="destructive">Stopped</Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                Master switch. Off stops <strong>every</strong> channel and drops all SMPP connections at once.
              </p>
            </div>
          </div>
          <Switch
            checked={allOn}
            disabled={mutate.isPending}
            aria-label="All services"
            onCheckedChange={(on) =>
              flip({ all_enabled: on }, "All services", on, {
                title: "Stop all services?",
                body: (
                  <>
                    This immediately refuses all new SMS (HTTP API, SMPP and bulk) and drops every live SMPP bind
                    across the whole gateway. Messages already accepted and queued will still be delivered. Turn it
                    back on here to resume.
                  </>
                ),
              })
            }
          />
        </CardContent>
      </Card>

      {/* Per-channel switches */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Services</CardTitle>
          <CardDescription>
            {allOn
              ? "Turn individual services off without stopping everything."
              : "The master switch is off, so all services are stopped regardless of the toggles below."}
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          {CHANNELS.map(({ key, label, icon: Icon, desc }) => {
            const on = data[key];
            return (
              <div key={key} className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="flex items-start gap-3">
                  <Icon className="mt-0.5 h-5 w-5 text-muted-foreground" aria-hidden />
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{label}</span>
                      {!allOn ? (
                        <Badge variant="muted">Stopped by master</Badge>
                      ) : on ? (
                        <Badge variant="success">On</Badge>
                      ) : (
                        <Badge variant="destructive">Off</Badge>
                      )}
                    </div>
                    <p className="max-w-prose text-sm text-muted-foreground">{desc}</p>
                  </div>
                </div>
                <Switch
                  checked={on}
                  disabled={mutate.isPending || !allOn}
                  aria-label={label}
                  onCheckedChange={(next) =>
                    flip({ [key]: next } as ServiceSwitchesUpdate, label, next, {
                      title: `Turn off ${label}?`,
                      body: <>{desc} It stays off until you turn it back on here.</>,
                    })
                  }
                />
              </div>
            );
          })}
        </CardContent>
      </Card>

      {updatedAt ? (
        <p className="mt-3 text-xs text-muted-foreground">Last changed {updatedAt.toLocaleString()}.</p>
      ) : null}

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(v) => {
          if (!v) setPending(null);
        }}
        title={pending?.title ?? ""}
        description={pending?.body}
        confirmLabel="Turn off"
        destructive
        onConfirm={async () => {
          if (!pending) return;
          await mutate.mutateAsync({ patch: pending.patch, label: pending.label, on: false });
          setPending(null);
        }}
      />
    </>
  );
}
