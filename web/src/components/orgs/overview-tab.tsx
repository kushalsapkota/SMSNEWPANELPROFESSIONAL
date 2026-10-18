"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form } from "@/components/ui/form";
import { NumberField, SubmitButton, TextField } from "@/components/shared/form-fields";
import { Money } from "@/components/shared/money";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { api, qk } from "@/lib/api";
import type { OrgDetail, OrgEffectiveState } from "@/lib/api/types";
import { formatDateTime, formatNumber } from "@/lib/format";
import { positiveIntOrNull } from "@/lib/validation";
import type { OrgKind } from "./kind";

const schema = z.object({
  name: z.string().trim().min(2, "At least 2 characters").max(200),
  brand_name: z.string().trim().max(100),
  max_tps: z.number({ invalid_type_error: "Required" }).int().positive("Must be > 0").max(100_000),
  daily_limit: positiveIntOrNull,
  monthly_limit: positiveIntOrNull,
  timezone: z.string().trim().min(1, "Required"),
  whitelabel_domain: z
    .string()
    .trim()
    .toLowerCase()
    .refine((v) => v === "" || /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(v), "Enter a domain like panel.example.com"),
});
type Values = z.input<typeof schema>;
type Output = z.output<typeof schema>;

function toValues(o: OrgDetail): Values {
  return {
    name: o.name,
    brand_name: o.brand_name ?? "",
    max_tps: o.max_tps,
    daily_limit: o.daily_limit,
    monthly_limit: o.monthly_limit,
    timezone: o.timezone,
    whitelabel_domain: o.whitelabel_domain ?? "",
  };
}

const EFFECTIVE: Array<{ key: keyof Omit<OrgEffectiveState, "effective_max_tps">; label: string }> = [
  { key: "is_active", label: "Account active" },
  { key: "can_send", label: "Can send" },
  { key: "can_api", label: "HTTP API" },
  { key: "can_smpp", label: "SMPP" },
];

export function EffectiveStateCard({ org }: { org: OrgDetail }) {
  const e = org.effective_state;
  if (!e) return null;
  const inherited =
    (org.status === "ACTIVE" && !e.is_active) ||
    (org.sending_enabled && e.is_active && !e.can_send) ||
    org.max_tps > e.effective_max_tps;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Effective state</CardTitle>
        <CardDescription>
          What the gateway enforces right now — this account&apos;s flags combined with its parent&apos;s.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="grid gap-2 sm:grid-cols-2">
          {EFFECTIVE.map(({ key, label }) => (
            <li key={key} className="flex items-center gap-2 text-sm">
              {e[key] ? (
                <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
              ) : (
                <XCircle className="h-4 w-4 text-destructive" aria-hidden />
              )}
              <span>{label}</span>
              <span className="sr-only">{e[key] ? "yes" : "no"}</span>
            </li>
          ))}
          <li className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Effective TPS:</span>
            <span className="font-medium tabular-nums">{formatNumber(e.effective_max_tps)}</span>
          </li>
        </ul>
        {inherited ? (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Restricted by parent</AlertTitle>
            <AlertDescription>
              Some capabilities are blocked or capped by the parent reseller.
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function OverviewTab({ org, kind }: { org: OrgDetail; kind: OrgKind }) {
  const form = useForm<Values, unknown, Output>({
    resolver: zodResolver(schema),
    defaultValues: toValues(org),
  });
  useEffect(() => {
    form.reset(toValues(org));
  }, [org, form]);

  const save = useApiMutation({
    mutationFn: (v: Output) =>
      api.orgs.update(org.id, {
        name: v.name,
        brand_name: v.brand_name || null,
        max_tps: v.max_tps,
        daily_limit: v.daily_limit,
        monthly_limit: v.monthly_limit,
        timezone: v.timezone,
        ...(kind === "reseller" ? { whitelabel_domain: v.whitelabel_domain || null } : {}),
      }),
    success: "Changes saved",
    invalidate: [qk.orgs.all],
  });

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-1">
        {org.status === "SUSPENDED" ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Suspended</AlertTitle>
            <AlertDescription>{org.suspended_reason || "No reason given."}</AlertDescription>
          </Alert>
        ) : null}
        <EffectiveStateCard org={org} />
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              {org.balance ? (
                <>
                  <dt className="text-muted-foreground">Balance</dt>
                  <dd className="text-right font-medium">
                    <Money micros={org.balance.balance_micros} currency={org.balance.currency} />
                  </dd>
                  <dt className="text-muted-foreground">Billing</dt>
                  <dd className="text-right">{org.balance.billing_mode === "POSTPAID" ? "Postpaid" : "Prepaid"}</dd>
                </>
              ) : null}
              {org.counts.users !== undefined ? (
                <>
                  <dt className="text-muted-foreground">Users</dt>
                  <dd className="text-right tabular-nums">{formatNumber(org.counts.users)}</dd>
                </>
              ) : null}
              {org.counts.clients !== undefined ? (
                <>
                  <dt className="text-muted-foreground">Clients</dt>
                  <dd className="text-right tabular-nums">{formatNumber(org.counts.clients)}</dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">Webhooks</dt>
              <dd className="text-right tabular-nums">{formatNumber(org.counts.webhooks)}</dd>
              <dt className="text-muted-foreground">Sender IDs</dt>
              <dd className="text-right tabular-nums">{formatNumber(org.counts.sender_ids)}</dd>
              {org.counts.api_keys !== undefined ? (
                <>
                  <dt className="text-muted-foreground">API keys</dt>
                  <dd className="text-right tabular-nums">{formatNumber(org.counts.api_keys)}</dd>
                </>
              ) : null}
              {org.counts.smpp_accounts !== undefined ? (
                <>
                  <dt className="text-muted-foreground">SMPP accounts</dt>
                  <dd className="text-right tabular-nums">{formatNumber(org.counts.smpp_accounts)}</dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">Created</dt>
              <dd className="text-right">{formatDateTime(org.created_at)}</dd>
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Profile &amp; limits</CardTitle>
          <CardDescription>Name, branding and throughput limits.</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-4" noValidate>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField control={form.control} name="name" label="Name" />
                <TextField
                  control={form.control}
                  name="brand_name"
                  label="Brand name"
                  description="Used for {brand} in OTP templates."
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <NumberField control={form.control} name="max_tps" label="Max TPS" min={1} />
                <NumberField control={form.control} name="daily_limit" label="Daily limit" placeholder="Unlimited" />
                <NumberField control={form.control} name="monthly_limit" label="Monthly limit" placeholder="Unlimited" />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField control={form.control} name="timezone" label="Timezone" placeholder="UTC" />
                {kind === "reseller" ? (
                  <TextField
                    control={form.control}
                    name="whitelabel_domain"
                    label="Whitelabel domain"
                    placeholder="panel.example.com"
                  />
                ) : null}
              </div>
              <div className="flex justify-end">
                <SubmitButton pending={save.isPending} disabled={!form.formState.isDirty}>
                  Save changes
                </SubmitButton>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
