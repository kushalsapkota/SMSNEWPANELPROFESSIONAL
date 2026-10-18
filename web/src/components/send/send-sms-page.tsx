"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2, Megaphone, RotateCcw, Send } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SelectFilter } from "@/components/data-table";
import { RecipientsInput, recipientStats } from "@/components/messaging/recipients-input";
import { SenderInput, useSenderIds } from "@/components/messaging/sender-input";
import { SmsCounter } from "@/components/messaging/sms-counter";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { Money } from "@/components/shared/money";
import { PageHeader } from "@/components/shared/page-header";
import { useDebouncedValue } from "@/hooks/use-debounce";
import { useRouteOptions } from "@/hooks/use-route-options";
import { api, errorMessage, isApiError, qk } from "@/lib/api";
import type { ErrorCode, SendResult } from "@/lib/api/types";
import { useSession } from "@/lib/auth/session";
import { formatNumber } from "@/lib/format";
import { isValidSender } from "@/lib/phone";
import { estimateCost } from "@/lib/rates";
import { analyzeSms } from "@/lib/sms";
import { SendResults } from "./send-results";

/** api limit per POST /api/messages/send (CONTRACTS §10). */
const CHUNK = 1000;
/** quick send cap; larger lists belong in a campaign */
const MAX_RECIPIENTS = 10_000;
const MAX_TEXT = 5000;

export function SendSmsPage() {
  const { org } = useSession();
  const [recipients, setRecipients] = useState("");
  const [sender, setSender] = useState("");
  const [text, setText] = useState("");
  const [routeId, setRouteId] = useState<string | undefined>();
  const [results, setResults] = useState<SendResult[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [touched, setTouched] = useState(false);

  const senders = useSenderIds();
  const routes = useRouteOptions();
  const balance = useQuery({
    queryKey: qk.orgs.balance(org.id),
    queryFn: () => api.orgs.balance(org.id),
    staleTime: 30_000,
    retry: false,
  });
  const rates = useQuery({
    queryKey: qk.orgs.routes(org.id),
    queryFn: () => api.orgs.routes(org.id),
    staleTime: 60_000,
    retry: false,
  });
  const currency = balance.data?.currency ?? "USD";

  // Default to the first approved sender once known.
  useEffect(() => {
    if (!sender && senders.approved.length > 0) setSender(senders.approved[0].sender);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [senders.approved.length]);

  const debouncedRecipients = useDebouncedValue(recipients, 150);
  const stats = useMemo(() => recipientStats(debouncedRecipients), [debouncedRecipients]);
  const analysis = useMemo(() => analyzeSms(text), [text]);
  const estimate = useMemo(
    () => (rates.data && analysis.parts > 0 ? estimateCost(rates.data, stats.valid, analysis.parts, routeId) : null),
    [rates.data, stats.valid, analysis.parts, routeId],
  );
  const available = balance.data
    ? balance.data.balance_micros + (balance.data.billing_mode === "POSTPAID" ? balance.data.credit_limit_micros : 0)
    : null;

  const errors = {
    recipients:
      stats.valid.length === 0
        ? "Add at least one valid number"
        : stats.valid.length > MAX_RECIPIENTS
          ? `At most ${formatNumber(MAX_RECIPIENTS)} recipients per quick send. Use a campaign for more.`
          : null,
    sender: !sender ? "Pick or type a sender" : !isValidSender(sender) ? "Invalid sender" : null,
    text: !text.trim() ? "Write a message" : text.length > MAX_TEXT ? `At most ${MAX_TEXT} characters` : analysis.tooLong ? "Too long" : null,
  };
  const invalid = Object.values(errors).some(Boolean);
  const sending = progress !== null;

  const doSend = async () => {
    const all = recipientStats(recipients).valid; // not the debounced view: send exactly what is typed
    const out: SendResult[] = [];
    setResults(null);
    setProgress({ done: 0, total: all.length });
    try {
      for (let i = 0; i < all.length; i += CHUNK) {
        const chunk = all.slice(i, i + CHUNK);
        try {
          const res = await api.messages.send({
            to: chunk.length === 1 ? chunk[0] : chunk,
            from: sender.trim(),
            text,
            route_id: routeId,
          });
          out.push(...res.messages);
        } catch (e) {
          // Single-recipient rejections come back as the error itself (CONTRACTS §11);
          // a failed batch marks every recipient of the chunk.
          const code = (isApiError(e) && e.code !== "NETWORK_ERROR" && e.code !== "UNKNOWN" ? e.code : "INTERNAL") as ErrorCode;
          for (const to of chunk) out.push({ to, error_code: code, message: errorMessage(e) });
          // Account-level problems would fail every following chunk too.
          if (["ACCOUNT_SUSPENDED", "SENDING_DISABLED", "CHANNEL_DISABLED", "INSUFFICIENT_FUNDS", "UNAUTHORIZED", "FORBIDDEN"].includes(code) && i + CHUNK < all.length) {
            for (const to of all.slice(i + CHUNK)) out.push({ to, error_code: code, message: `Not sent: ${errorMessage(e)}` });
            break;
          }
        }
        setProgress({ done: Math.min(all.length, i + CHUNK), total: all.length });
      }
    } finally {
      setProgress(null);
      setResults(out);
      void balance.refetch();
    }
    const ok = out.filter((r) => "message_id" in r).length;
    if (ok === out.length) toast.success(`${formatNumber(ok)} ${ok === 1 ? "message" : "messages"} accepted`);
    else if (ok === 0) toast.error("Nothing was sent", { description: "See the results table for the reasons." });
    else toast.warning(`${formatNumber(ok)} accepted, ${formatNumber(out.length - ok)} rejected`);
  };

  const submit = () => {
    setTouched(true);
    if (invalid) return;
    if (stats.valid.length > 1) setConfirm(true);
    else void doSend();
  };

  return (
    <>
      <PageHeader
        title="Send SMS"
        description="Quick send from the web panel. For personalised bulk messages use a campaign."
        actions={
          <Button variant="outline" asChild>
            <Link href="/campaigns/new">
              <Megaphone aria-hidden /> New campaign
            </Link>
          </Button>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card>
          <CardContent className="space-y-6 pt-6">
            <RecipientsInput value={recipients} onChange={setRecipients} stats={stats} max={MAX_RECIPIENTS} />
            {touched && errors.recipients ? <p className="-mt-4 text-[0.8rem] font-medium text-destructive">{errors.recipients}</p> : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <SenderInput value={sender} onChange={setSender} routeId={routeId} error={touched ? errors.sender : null} />
              <div className="space-y-2">
                <Label>Route</Label>
                <SelectFilter
                  label="Route"
                  allLabel="Automatic (best route)"
                  value={routeId}
                  onChange={setRouteId}
                  options={routes.options.map((r) => ({ value: r.value, label: r.label }))}
                  className="sm:w-full"
                />
                <p className="text-[0.8rem] text-muted-foreground">Force one of your routes, or let the gateway pick.</p>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="sms-text">Message</Label>
              <Textarea
                id="sms-text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={6}
                placeholder="Type your message…"
                aria-invalid={(touched && !!errors.text) || undefined}
              />
              <SmsCounter text={text} analysis={analysis} onFix={setText} />
              {touched && errors.text ? <p className="text-[0.8rem] font-medium text-destructive">{errors.text}</p> : null}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={submit} disabled={sending || (touched && invalid)}>
                {sending ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
                {sending
                  ? `Sending ${formatNumber(progress?.done ?? 0)} / ${formatNumber(progress?.total ?? 0)}…`
                  : `Send to ${formatNumber(stats.valid.length)} ${stats.valid.length === 1 ? "recipient" : "recipients"}`}
              </Button>
              {results ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setResults(null);
                    setRecipients("");
                    setTouched(false);
                  }}
                >
                  <RotateCcw aria-hidden /> New message
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Summary</CardTitle>
              <CardDescription>Estimate before templates and routing.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Recipients" value={formatNumber(stats.valid.length)} />
              <Row label="Parts per message" value={analysis.parts || "—"} />
              <Row label="Total parts" value={formatNumber(stats.valid.length * analysis.parts)} />
              <Row
                label="Estimated cost"
                value={
                  estimate ? (
                    <Money micros={estimate.total_micros} currency={currency} />
                  ) : rates.isError ? (
                    "Rates unavailable"
                  ) : (
                    "—"
                  )
                }
              />
              {estimate && estimate.unpriced.length > 0 ? (
                <p className="text-xs text-warning">
                  {formatNumber(estimate.unpriced.length)} {estimate.unpriced.length === 1 ? "number has" : "numbers have"} no route
                  {routeId ? " on the selected route" : ""} and will be rejected (ROUTE_NOT_FOUND).
                </p>
              ) : null}
              <Row
                label="Available"
                value={balance.data ? <Money micros={available} currency={currency} /> : "—"}
              />
            </CardContent>
          </Card>
          {estimate && available !== null && estimate.total_micros > available ? (
            <Alert variant="destructive">
              <AlertTitle>Not enough balance</AlertTitle>
              <AlertDescription>
                The estimate exceeds your available balance; some messages will be rejected with INSUFFICIENT_FUNDS.
              </AlertDescription>
            </Alert>
          ) : null}
          {senders.restricted && senders.approved.length === 0 ? (
            <Alert>
              <AlertTitle>No approved sender IDs yet</AlertTitle>
              <AlertDescription>
                Your sender ID requests are pending. <Link href="/sender-ids" className="underline">View status</Link>.
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
      </div>

      {results ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-base">Results</CardTitle>
            <CardDescription>Accepted messages are queued for delivery; track them in Messages.</CardDescription>
          </CardHeader>
          <CardContent>
            <SendResults results={results} currency={currency} />
          </CardContent>
        </Card>
      ) : null}

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        destructive={false}
        title={`Send to ${formatNumber(stats.valid.length)} recipients?`}
        description={
          <div className="space-y-1">
            <p>
              {formatNumber(stats.valid.length * analysis.parts)} SMS parts from <span className="font-mono">{sender}</span>.
            </p>
            {estimate ? (
              <p>
                Estimated cost: <Money micros={estimate.total_micros} currency={currency} />
              </p>
            ) : null}
          </div>
        }
        confirmLabel="Send now"
        onConfirm={() => {
          setConfirm(false);
          void doSend();
        }}
      />
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}
