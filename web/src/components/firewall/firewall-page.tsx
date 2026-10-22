"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, ShieldAlert, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorState, FullPageSpinner } from "@/components/shared/states";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { api, qk } from "@/lib/api";
import type { FirewallRule, FirewallState, FirewallStatus } from "@/lib/api/types";

const BLANK_RULE: FirewallRule = { action: "allow", proto: "tcp", port: null, source: null };

export function FirewallPage() {
  const q = useQuery({
    queryKey: qk.firewall.status,
    queryFn: () => api.firewall.status(),
    // While a change is staged, poll so the auto-revert countdown stays live.
    refetchInterval: (query) => (query.state.data?.pending_revert ? 1000 : false),
  });

  if (q.isLoading) return <FullPageSpinner />;
  if (q.isError || !q.data) {
    return (
      <>
        <PageHeader title="Firewall" description="Host firewall rules." />
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      </>
    );
  }
  return <FirewallEditor status={q.data} />;
}

function FirewallEditor({ status }: { status: FirewallStatus }) {
  const invalidate = [qk.firewall.all, qk.auditLogs.all];
  const [draft, setDraft] = useState<FirewallState>({
    enabled: status.enabled,
    default_policy: status.default_policy,
    rules: status.rules,
  });

  // Re-sync the editor from the server whenever nothing is staged (e.g. after commit/revert).
  useEffect(() => {
    if (!status.pending_revert) {
      setDraft({ enabled: status.enabled, default_policy: status.default_policy, rules: status.rules });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.enabled, status.default_policy, status.pending_revert, JSON.stringify(status.rules)]);

  const apply = useApiMutation({
    mutationFn: () => api.firewall.apply(draft),
    success: `Rules applied — they auto-revert in ${status.revert_in_seconds || 60}s unless you keep them`,
    invalidate,
  });
  const commit = useApiMutation({
    mutationFn: () => api.firewall.commit(),
    success: "Rules kept",
    invalidate,
  });
  const revert = useApiMutation({
    mutationFn: () => api.firewall.revert(),
    success: "Reverted to the last kept rules",
    invalidate,
  });

  if (!status.available) {
    return (
      <>
        <PageHeader title="Firewall" description="Host firewall rules." />
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Firewall agent not deployed</CardTitle>
            <CardDescription>
              The privileged <code>firewall-agent</code> container isn&apos;t running (or{" "}
              <code>FW_AGENT_TOKEN</code> isn&apos;t set). Start it with the compose stack and set the token
              in <code>deploy/.env</code> to manage the host firewall from here.
            </CardDescription>
          </CardHeader>
        </Card>
      </>
    );
  }

  const setRule = (i: number, patch: Partial<FirewallRule>) =>
    setDraft((d) => ({ ...d, rules: d.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const addRule = () => setDraft((d) => ({ ...d, rules: [...d.rules, { ...BLANK_RULE }] }));
  const removeRule = (i: number) => setDraft((d) => ({ ...d, rules: d.rules.filter((_, j) => j !== i) }));

  return (
    <>
      <PageHeader
        title="Firewall"
        description="Host-level nftables rules. SSH, the panel and SMPP ports are always allowed and can't be blocked here."
      />

      {status.pending_revert ? (
        <Card className="mb-4 border-amber-500/50 bg-amber-500/5">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
            <div className="flex items-center gap-2 text-sm">
              <ShieldAlert className="h-4 w-4 text-amber-500" />
              <span>
                New rules are live but will <strong>auto-revert in {status.revert_in_seconds}s</strong>. Keep them if
                you&apos;re still connected and everything works.
              </span>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => revert.mutate()} disabled={revert.isPending}>
                Revert now
              </Button>
              <Button onClick={() => commit.mutate()} disabled={commit.isPending}>
                Keep these rules
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <CardTitle className="text-base">Firewall</CardTitle>
              <CardDescription>
                {status.table_active ? (
                  <Badge variant="success">Active</Badge>
                ) : (
                  <Badge variant="muted">Inactive</Badge>
                )}{" "}
                <span className="text-muted-foreground">
                  Always open: TCP {status.protected_tcp_ports.join(", ")}
                </span>
              </CardDescription>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={draft.enabled}
                onCheckedChange={(enabled) => setDraft((d) => ({ ...d, enabled }))}
                aria-label="Enable firewall"
              />
              Enforce firewall
            </label>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex flex-wrap items-center gap-3">
            <Label className="text-sm">Traffic not matched by a rule below</Label>
            <Select
              value={draft.default_policy}
              onValueChange={(v) => setDraft((d) => ({ ...d, default_policy: v as FirewallState["default_policy"] }))}
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="allow">is allowed</SelectItem>
                <SelectItem value="deny">is blocked</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-sm">Rules (evaluated top to bottom)</Label>
              <Button type="button" variant="outline" size="sm" onClick={addRule}>
                <Plus className="mr-1 h-4 w-4" /> Add rule
              </Button>
            </div>
            {draft.rules.length === 0 ? (
              <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                No custom rules. With the default policy above, traffic to non-protected ports is{" "}
                {draft.default_policy === "deny" ? "blocked" : "allowed"}.
              </p>
            ) : (
              <div className="space-y-2">
                {draft.rules.map((r, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                    <Select value={r.action} onValueChange={(v) => setRule(i, { action: v as FirewallRule["action"] })}>
                      <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="allow">Allow</SelectItem>
                        <SelectItem value="deny">Block</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select value={r.proto} onValueChange={(v) => setRule(i, { proto: v as FirewallRule["proto"] })}>
                      <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="tcp">TCP</SelectItem>
                        <SelectItem value="udp">UDP</SelectItem>
                        <SelectItem value="any">Any</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      className="w-28"
                      inputMode="numeric"
                      placeholder="port (any)"
                      value={r.port ?? ""}
                      onChange={(e) => {
                        const n = e.target.value.trim();
                        setRule(i, { port: n === "" ? null : Number(n) });
                      }}
                    />
                    <Input
                      className="min-w-48 flex-1"
                      placeholder="source IP / CIDR (any)"
                      value={r.source ?? ""}
                      onChange={(e) => setRule(i, { source: e.target.value.trim() === "" ? null : e.target.value.trim() })}
                    />
                    <Button type="button" variant="ghost" size="icon" onClick={() => removeRule(i)} aria-label="Remove rule">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t pt-4">
            <span className="mr-auto text-xs text-muted-foreground">
              Applying stages the rules for {status.revert_in_seconds || 60}s, then reverts unless you keep them.
            </span>
            <Button onClick={() => apply.mutate()} disabled={apply.isPending || status.pending_revert}>
              Apply rules
            </Button>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
