"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Circle, Clock, XCircle } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { CopyButton } from "@/components/shared/copy-button";
import { Money } from "@/components/shared/money";
import { ErrorState, LoadingState } from "@/components/shared/states";
import { StatusBadge } from "@/components/shared/status-badge";
import { api, qk } from "@/lib/api";
import type { MessageLog, MsgStatus, OrgRole } from "@/lib/api/types";
import { formatDateTime } from "@/lib/format";
import { analyzeSms } from "@/lib/sms";
import { cn } from "@/lib/utils";

const FINAL: MsgStatus[] = ["DELIVERED", "UNDELIVERED", "FAILED", "EXPIRED", "REJECTED", "UNKNOWN"];
export const isFinal = (s: MsgStatus) => FINAL.includes(s);

export function latencyMs(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const d = new Date(b).getTime() - new Date(a).getTime();
  return Number.isFinite(d) ? d : null;
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export interface TimelineStep {
  label: string;
  at: string | null;
  state: "done" | "pending" | "failed" | "skipped";
  latency?: number | null;
  detail?: ReactNode;
}

/** accepted → submitted → DLR steps for a message (shared with the tester). */
export function messageTimeline(
  m: Pick<MessageLog, "created_at" | "submitted_at" | "dlr_received_at" | "status" | "dlr_stat" | "dlr_err" | "error_code">,
  timings?: { accepted_at?: string | null; submit_latency_ms?: number | null; dlr_latency_ms?: number | null },
): TimelineStep[] {
  const accepted = timings?.accepted_at ?? m.created_at;
  const failedBeforeSubmit = !m.submitted_at && (m.status === "FAILED" || m.status === "REJECTED");
  const dlrFailed = m.status === "UNDELIVERED" || m.status === "EXPIRED" || m.status === "REJECTED" || (m.status === "FAILED" && !!m.submitted_at);
  return [
    { label: "Accepted", at: accepted, state: "done" },
    {
      label: "Submitted to carrier",
      at: m.submitted_at,
      state: m.submitted_at ? "done" : failedBeforeSubmit ? "failed" : "pending",
      latency: timings?.submit_latency_ms ?? latencyMs(accepted, m.submitted_at),
      detail: failedBeforeSubmit && m.error_code ? <span className="font-mono">{m.error_code}</span> : undefined,
    },
    {
      label: "Delivery report",
      at: m.dlr_received_at,
      state: m.dlr_received_at ? (dlrFailed ? "failed" : "done") : failedBeforeSubmit ? "skipped" : "pending",
      latency: timings?.dlr_latency_ms ?? latencyMs(m.submitted_at, m.dlr_received_at),
      detail: m.dlr_stat ? (
        <span className="font-mono">
          stat:{m.dlr_stat}
          {m.dlr_err ? ` err:${m.dlr_err}` : ""}
        </span>
      ) : undefined,
    },
  ];
}

export function Timeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <ol className="space-y-0">
      {steps.map((s, i) => {
        const Icon = s.state === "done" ? CheckCircle2 : s.state === "failed" ? XCircle : s.state === "pending" ? Clock : Circle;
        return (
          <li key={s.label} className="relative flex gap-3 pb-4 last:pb-0">
            {i < steps.length - 1 ? <span aria-hidden className="absolute left-[9px] top-6 h-[calc(100%-1.25rem)] w-px bg-border" /> : null}
            <Icon
              className={cn(
                "mt-0.5 h-5 w-5 shrink-0",
                s.state === "done" && "text-success",
                s.state === "failed" && "text-destructive",
                s.state === "pending" && "animate-pulse text-warning",
                s.state === "skipped" && "text-muted-foreground",
              )}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                <span className="text-sm font-medium">
                  {s.label}
                  <span className="sr-only"> ({s.state})</span>
                </span>
                {s.latency !== undefined && s.latency !== null ? (
                  <span className="text-xs tabular-nums text-muted-foreground">+{formatLatency(s.latency)}</span>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                {s.at ? formatDateTime(s.at) : s.state === "pending" ? "Waiting…" : s.state === "skipped" ? "Not applicable" : "—"}
                {s.at ? ` · ${new Date(s.at).toLocaleTimeString("en-US", { hour12: false, fractionalSecondDigits: 3 } as Intl.DateTimeFormatOptions)}` : ""}
              </p>
              {s.detail ? <div className="mt-0.5 text-xs">{s.detail}</div> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Field({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("break-words text-sm", mono && "font-mono")}>{children ?? "—"}</dd>
    </div>
  );
}

/** Money fields visible to each role (the api already nulls what RLS hides). */
function Costs({ m, role, currency }: { m: MessageLog; role: OrgRole; currency: string }) {
  const rows: Array<[string, number | null]> = [];
  if (role === "CLIENT") {
    rows.push(["Cost", m.client_cost_micros], ["Rate per part", m.client_rate_micros]);
  } else if (role === "RESELLER") {
    rows.push(["Client charge", m.client_cost_micros], ["Your cost", m.reseller_cost_micros]);
  } else {
    rows.push(["Client charge", m.client_cost_micros], ["Reseller charge", m.reseller_cost_micros], ["Route cost", m.route_cost_micros]);
  }
  const revenue = role === "RESELLER" ? m.client_cost_micros : role === "SUPER_ADMIN" ? m.reseller_cost_micros : null;
  const cost = role === "RESELLER" ? m.reseller_cost_micros : role === "SUPER_ADMIN" ? m.route_cost_micros : null;
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {rows.map(([label, v]) => (
        <Field key={label} label={label}>
          <Money micros={v} currency={currency} />
        </Field>
      ))}
      {revenue !== null && cost !== null ? (
        <Field label="Margin">
          <Money micros={revenue - cost} currency={currency} signed />
        </Field>
      ) : null}
      <Field label="Refunded">{m.refunded ? <Badge variant="success">Refunded</Badge> : "No"}</Field>
    </dl>
  );
}

/** Message detail drawer: texts, parts, DLR, costs, timeline. */
export function MessageDrawer({
  id,
  initial,
  onClose,
  role,
  currency,
}: {
  id: string | null;
  initial?: MessageLog;
  onClose: () => void;
  role: OrgRole;
  currency: string;
}) {
  const q = useQuery({
    queryKey: qk.messages.detail(id ?? ""),
    queryFn: () => api.messages.get(id!),
    enabled: !!id,
    placeholderData: initial && initial.id === id ? initial : undefined,
    refetchInterval: (query) => (query.state.data && !isFinal(query.state.data.status) ? 5000 : false),
  });
  const m = q.data;
  const templated = m ? m.sent_text !== null && m.sent_text !== m.orig_text : false;
  const origA = m ? analyzeSms(m.orig_text) : null;
  const sentA = m?.sent_text ? analyzeSms(m.sent_text) : null;

  return (
    <Sheet open={!!id} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="flex flex-wrap items-center gap-2">
            Message {m ? <StatusBadge status={m.status} /> : null}
          </SheetTitle>
          <SheetDescription className="flex items-center gap-1 font-mono text-xs">
            {id}
            {id ? <CopyButton value={id} label="Copy message ID" /> : null}
          </SheetDescription>
        </SheetHeader>
        {q.isLoading && !m ? (
          <LoadingState rows={6} />
        ) : q.isError && !m ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : m ? (
          <div className="mt-4 space-y-6">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Field label="From" mono>
                {m.source_addr}
              </Field>
              <Field label="To" mono>
                {m.destination_addr}
              </Field>
              <Field label="Channel">{m.channel}</Field>
              {role !== "CLIENT" ? <Field label="Account">{m.org_name ?? m.org_id}</Field> : null}
              <Field label="Route">{m.route_name ?? (m.route_id ? m.route_id.slice(0, 8) : null)}</Field>
              {m.connection_name ? <Field label="Connection">{m.connection_name}</Field> : null}
              <Field label="Country">{m.country_iso}</Field>
              {m.mccmnc ? <Field label="MCC/MNC" mono>{m.mccmnc}</Field> : null}
              <Field label="Client ref" mono>
                {m.client_msg_ref}
              </Field>
              {m.campaign_id ? (
                <Field label="Campaign">
                  {role === "CLIENT" ? (
                    <Link href={`/campaigns/${m.campaign_id}`} className="underline">
                      Open campaign
                    </Link>
                  ) : (
                    <span className="font-mono text-xs">{m.campaign_id.slice(0, 8)}</span>
                  )}
                </Field>
              ) : null}
            </dl>

            <section className="space-y-3">
              <h3 className="text-sm font-semibold">Text</h3>
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>Original (as submitted)</span>
                  {origA ? <span>{origA.encoding === "GSM7" ? "GSM-7" : "UCS-2"} · {origA.chars} chars</span> : null}
                </div>
                <p className="whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 text-sm">{m.orig_text}</p>
              </div>
              {templated ? (
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <ArrowRight className="h-3 w-3" aria-hidden /> Sent (templated
                      {m.otp_extracted ? ", OTP extracted" : m.otp_extracted === false ? ", no OTP found" : ""})
                    </span>
                    {sentA ? <span>{sentA.encoding === "GSM7" ? "GSM-7" : "UCS-2"} · {sentA.chars} chars</span> : null}
                  </div>
                  <p className="whitespace-pre-wrap break-words rounded-md border border-success/40 bg-success/5 p-3 text-sm">{m.sent_text}</p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{m.sent_text === null ? "Not sent yet." : "Sent unchanged."}</p>
              )}
              <dl className="grid grid-cols-3 gap-3">
                <Field label="Encoding">{m.encoding === "GSM7" ? "GSM-7" : "UCS-2"}</Field>
                <Field label="Parts">{m.parts}</Field>
                <Field label="SMSC IDs" mono>
                  {m.smsc_msg_ids?.length ? m.smsc_msg_ids.join(", ") : null}
                </Field>
              </dl>
            </section>

            <Separator />

            <section className="space-y-3">
              <h3 className="text-sm font-semibold">Delivery</h3>
              <dl className="grid grid-cols-3 gap-3">
                <Field label="DLR stat" mono>
                  {m.dlr_stat}
                </Field>
                <Field label="DLR err" mono>
                  {m.dlr_err}
                </Field>
                <Field label="Error code" mono>
                  {m.error_code}
                </Field>
              </dl>
              <Timeline steps={messageTimeline(m)} />
            </section>

            <Separator />

            <section className="space-y-3">
              <h3 className="text-sm font-semibold">Billing</h3>
              <Costs m={m} role={role} currency={currency} />
            </section>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
