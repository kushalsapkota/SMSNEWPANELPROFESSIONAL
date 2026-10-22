"use client";

import { useQuery } from "@tanstack/react-query";
import { Globe, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
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
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorState, FullPageSpinner } from "@/components/shared/states";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { api, qk } from "@/lib/api";
import type { DomainEntry, DomainRole, DomainsStatus } from "@/lib/api/types";
import { formatDate } from "@/lib/format";

const ROLES: Array<{ value: DomainRole; label: string; hint: string }> = [
  { value: "panel", label: "Panel + API", hint: "Serves the web panel and HTTP API over HTTPS." },
  { value: "smpp", label: "SMPP only", hint: "HTTPS returns 404; SMPP clients still bind on :2775." },
  { value: "both", label: "Panel + API + SMPP", hint: "Panel over HTTPS; SMPP also works (it's by DNS/IP)." },
];

const roleLabel = (r: DomainRole) => ROLES.find((x) => x.value === r)?.label ?? r;

export function DomainsPage() {
  const q = useQuery({ queryKey: qk.domains.status, queryFn: () => api.domains.status() });

  if (q.isLoading) return <FullPageSpinner />;
  if (q.isError || !q.data) {
    return (
      <>
        <PageHeader title="Domains" description="Panel & SMPP domains served by this gateway." />
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      </>
    );
  }
  return <DomainsManager status={q.data} />;
}

function DomainsManager({ status }: { status: DomainsStatus }) {
  const invalidate = [qk.domains.all, qk.auditLogs.all];
  const [domain, setDomain] = useState("");
  const [role, setRole] = useState<DomainRole>("panel");
  const [removing, setRemoving] = useState<DomainEntry | null>(null);

  const add = useApiMutation({
    mutationFn: () => api.domains.add({ domain: domain.trim().toLowerCase(), role }),
    success: (d) => `${d.domain} is live`,
    invalidate,
    onSuccess: () => setDomain(""),
  });
  const remove = useApiMutation({
    mutationFn: (dom: string) => api.domains.remove(dom),
    success: (_d, dom) => `${dom} removed`,
    invalidate,
  });

  if (!status.available) {
    return (
      <>
        <PageHeader title="Domains" description="Panel & SMPP domains served by this gateway." />
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Domain agent not installed</CardTitle>
            <CardDescription>
              The privileged host <code>domain-agent</code> isn&apos;t running, so domains can&apos;t be managed
              from the panel. Install it on the host (<code>deploy/domain-agent/install.sh</code>) and set
              <code> DOMAIN_AGENT_TOKEN</code> for the API, then reload this page.
            </CardDescription>
          </CardHeader>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Domains" description="Add a domain and the gateway issues its TLS cert and serves it." />

      {!status.nginx_ok ? (
        <Card className="mb-4 border-destructive">
          <CardHeader>
            <CardTitle className="text-base text-destructive">nginx config test is failing</CardTitle>
            <CardDescription>
              The host&apos;s nginx currently fails <code>nginx -t</code>. New domains are blocked until it&apos;s
              healthy. Check the host nginx config.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Add a domain</CardTitle>
          <CardDescription>
            Point the domain&apos;s DNS at this server first. The gateway issues a Let&apos;s Encrypt certificate,
            writes an nginx vhost, and reloads nginx (validating first — a bad entry can&apos;t break the edge).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              if (domain.trim()) add.mutate(undefined);
            }}
          >
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="domain">Domain</Label>
              <Input
                id="domain"
                placeholder="panel.example.com"
                autoCapitalize="none"
                spellCheck={false}
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
              />
            </div>
            <div className="space-y-1.5 sm:w-56">
              <Label htmlFor="role">Role</Label>
              <Select value={role} onValueChange={(v) => setRole(v as DomainRole)}>
                <SelectTrigger id="role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={!domain.trim() || add.isPending}>
              <Plus className="mr-1.5 size-4" />
              {add.isPending ? "Issuing cert…" : "Add domain"}
            </Button>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">{ROLES.find((r) => r.value === role)?.hint}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Managed domains</CardTitle>
          <CardDescription>Domains configured through this panel. The hand-written edge vhost isn&apos;t shown.</CardDescription>
        </CardHeader>
        <CardContent>
          {status.domains.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
              <Globe className="size-8 opacity-40" />
              <p>No managed domains yet.</p>
            </div>
          ) : (
            <div className="divide-y rounded-lg border">
              {status.domains.map((d) => (
                <div key={d.domain} className="flex items-center justify-between gap-4 p-3">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{d.domain}</span>
                      <Badge variant="secondary">{roleLabel(d.role)}</Badge>
                      {!d.enabled ? <Badge variant="outline">disabled</Badge> : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {d.cert.exists
                        ? `TLS cert ${d.cert.expires ? `expires ${formatDate(d.cert.expires)}` : "installed"}`
                        : "no TLS cert"}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${d.domain}`}
                    disabled={remove.isPending}
                    onClick={() => setRemoving(d)}
                  >
                    <Trash2 className="size-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.domain ?? ""}?`}
        description="The nginx vhost is removed and nginx is reloaded. SMPP on :2775 is unaffected. The TLS certificate is kept on disk."
        confirmLabel="Remove domain"
        destructive
        onConfirm={async () => {
          if (removing) await remove.mutateAsync(removing.domain);
        }}
      />
    </>
  );
}
