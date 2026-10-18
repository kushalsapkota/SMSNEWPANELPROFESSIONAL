"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertTriangle, FlaskConical, Loader2, Send, Wand2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Textarea } from "@/components/ui/textarea";
import { SmsCounter } from "@/components/messaging/sms-counter";
import { Timeline, formatLatency, messageTimeline } from "@/components/messages/message-drawer";
import { CopyButton } from "@/components/shared/copy-button";
import { Money } from "@/components/shared/money";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/states";
import { StatusBadge } from "@/components/shared/status-badge";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { useCurrency } from "@/hooks/use-currency";
import { useDebouncedValue } from "@/hooks/use-debounce";
import { useRouteOptions } from "@/hooks/use-route-options";
import { ApiError, api, errorMessage, isApiError, qk } from "@/lib/api";
import type { MsgStatus, SubmitResult, TesterResult } from "@/lib/api/types";
import { useSession } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { isValidSender, normalizeMsisdn } from "@/lib/phone";
import { cn } from "@/lib/utils";

/** stop polling a test after this long without a final DLR */
const MAX_POLL_MS = 10 * 60_000;
const DEFAULT_TEXT = "Your verification code is 849201. Do not share it.";

interface TestEntry {
  id: string;
  sentAt: number;
  route_id: string;
  route_name: string;
  destination: string;
  source: string;
  text: string;
  submit: SubmitResult;
  /** latest poll result (kept so history shows outcomes) */
  last?: TesterResult;
}

function TemplatePreviewInline({ routeId, text }: { routeId: string; text: string }) {
  const body = useDebouncedValue(JSON.stringify({ route_id: routeId, text }), 400);
  const req = useMemo(() => JSON.parse(body) as { route_id: string; text: string }, [body]);
  const q = useQuery({
    queryKey: qk.templates.preview(req),
    queryFn: ({ signal }) => api.templates.preview(req, signal),
    enabled: !!req.text.trim(),
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 30_000,
  });
  const r = q.data;
  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3" aria-live="polite">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <Wand2 className="h-4 w-4" aria-hidden /> Template preview
        </span>
        {q.isFetching ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Updating" /> : null}
      </div>
      {q.isError ? (
        <p className="flex items-start gap-1.5 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {errorMessage(q.error)}
        </p>
      ) : !r ? (
        <p className="text-sm text-muted-foreground">Type a message to see what the route&apos;s template produces.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <StatusBadge status={r.action} />
            {r.otp ? (
              <span>
                OTP <code className="rounded bg-background px-1 font-mono">{r.otp}</code>
              </span>
            ) : (
              <span className="text-muted-foreground">No OTP found</span>
            )}
            <span className="text-muted-foreground">
              {r.encoding === "GSM7" ? "GSM-7" : "UCS-2"} · {r.parts} {r.parts === 1 ? "part" : "parts"}
            </span>
          </div>
          {r.output !== null ? (
            <p className="whitespace-pre-wrap break-words rounded-md border bg-background p-2 text-sm">{r.output}</p>
          ) : (
            <p className="text-sm text-destructive">The message would be rejected (OTP_NOT_FOUND).</p>
          )}
        </>
      )}
    </div>
  );
}

function ActiveTest({ entry, onUpdate, currency }: { entry: TestEntry; onUpdate: (r: TesterResult) => void; currency: string }) {
  const q = useQuery({
    queryKey: qk.tester.result(entry.id),
    queryFn: () => api.tester.get(entry.id),
    refetchInterval: (query) => {
      const d = query.state.data;
      // done: a DLR arrived, or the message failed without one being expected
      if (d && (d.message.dlr_received_at || d.message.status === "FAILED" || d.message.status === "REJECTED")) return false;
      return Date.now() - entry.sentAt > MAX_POLL_MS ? false : 1000;
    },
  });
  const data = q.data;
  useEffect(() => {
    if (data) onUpdate(data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const m = data?.message;
  const steps = m
    ? messageTimeline(m, data.timings)
    : messageTimeline({
        created_at: new Date(entry.sentAt).toISOString(),
        submitted_at: null,
        dlr_received_at: null,
        status: entry.submit.status,
        dlr_stat: null,
        dlr_err: null,
        error_code: null,
      });
  const done = !!m && (!!m.dlr_received_at || m.status === "FAILED" || m.status === "REJECTED");
  const polling = !done && Date.now() - entry.sentAt < MAX_POLL_MS;
  const status: MsgStatus = m?.status ?? entry.submit.status;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            Live result <StatusBadge status={status} />
          </CardTitle>
          <CardDescription className="flex items-center gap-1 font-mono text-xs">
            {entry.id}
            <CopyButton value={entry.id} label="Copy message ID" />
          </CardDescription>
        </div>
        {polling ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Waiting for DLR…
          </span>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-5">
        <Timeline steps={steps} />
        {q.isError && !(q.error instanceof ApiError && q.error.status === 404) ? (
          <p className="text-sm text-destructive">{errorMessage(q.error)}</p>
        ) : null}
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Submit latency</dt>
            <dd className="font-medium tabular-nums">{formatLatency(data?.timings.submit_latency_ms)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">DLR latency</dt>
            <dd className="font-medium tabular-nums">{formatLatency(data?.timings.dlr_latency_ms)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Parts / encoding</dt>
            <dd className="tabular-nums">
              {entry.submit.parts} · {entry.submit.encoding === "GSM7" ? "GSM-7" : "UCS-2"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Cost</dt>
            <dd>
              <Money micros={entry.submit.cost_micros} currency={currency} />
            </dd>
          </div>
          {m?.connection_name ? (
            <div>
              <dt className="text-xs text-muted-foreground">Connection</dt>
              <dd>{m.connection_name}</dd>
            </div>
          ) : null}
          {m?.dlr_stat ? (
            <div>
              <dt className="text-xs text-muted-foreground">DLR</dt>
              <dd className="font-mono text-xs">
                stat:{m.dlr_stat} err:{m.dlr_err ?? "—"}
              </dd>
            </div>
          ) : null}
        </dl>
        {entry.submit.sent_text !== entry.text ? (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Sent text (after template)</p>
            <p className="whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-2 text-sm">{entry.submit.sent_text}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function TesterPage() {
  const { role } = useSession();
  const currency = useCurrency();
  const routes = useRouteOptions();
  const [routeId, setRouteId] = useState<string>("");
  const [destination, setDestination] = useState("");
  const [source, setSource] = useState("TEST");
  const [text, setText] = useState(DEFAULT_TEXT);
  const [history, setHistory] = useState<TestEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [lastError, setLastError] = useState<ApiError | Error | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!routeId && routes.options.length > 0) setRouteId(routes.options.find((r) => r.enabled)?.value ?? routes.options[0].value);
  }, [routes.options, routeId]);

  const route = routes.options.find((r) => r.value === routeId);
  const dest = normalizeMsisdn(destination);
  const errors = {
    route: !routeId ? "Pick a route" : null,
    destination: !dest ? "6-15 digits, optionally with + / spaces" : null,
    source: !isValidSender(source.trim()) ? "Invalid sender" : null,
    text: !text.trim() ? "Required" : null,
  };
  const invalid = Object.values(errors).some(Boolean);

  const send = useApiMutation({
    mutationFn: () => api.tester.send({ route_id: routeId, destination: dest!, text, source: source.trim() }),
    errorTitle: false,
    success: false,
    invalidate: [qk.messages.all],
    onSuccess: (res) => {
      setLastError(null);
      const entry: TestEntry = {
        id: res.message_id,
        sentAt: Date.now(),
        route_id: routeId,
        route_name: route?.label ?? routeId,
        destination: dest!,
        source: source.trim(),
        text,
        submit: res,
      };
      setHistory((h) => [entry, ...h].slice(0, 25));
      setActiveId(res.message_id);
    },
    onError: (e) => setLastError(e instanceof Error ? e : new Error(errorMessage(e))),
  });

  const active = history.find((h) => h.id === activeId) ?? null;

  return (
    <>
      <PageHeader
        title="SMS Tester"
        description={
          role === "SUPER_ADMIN"
            ? "Send a test through a specific route and watch it end to end. Admin tests are not billed."
            : "Send a test through one of your routes and watch it end to end. Tests are billed at your rate."
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <Card>
          <CardContent className="space-y-4 pt-6">
            <form
              className="space-y-4"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                setTouched(true);
                if (!invalid) send.mutate();
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="tester-route">Route</Label>
                <Select value={routeId} onValueChange={setRouteId}>
                  <SelectTrigger id="tester-route">
                    <SelectValue placeholder={routes.isLoading ? "Loading…" : "Pick a route"} />
                  </SelectTrigger>
                  <SelectContent>
                    {routes.options.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                        {r.template_mode ? " · template" : ""}
                        {!r.enabled ? " (disabled)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {touched && errors.route ? <p className="text-[0.8rem] font-medium text-destructive">{errors.route}</p> : null}
                {!routes.isLoading && routes.options.length === 0 ? (
                  <p className="text-[0.8rem] text-muted-foreground">No routes available to test.</p>
                ) : null}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="tester-dest">Destination</Label>
                  <Input
                    id="tester-dest"
                    type="tel"
                    inputMode="tel"
                    className="font-mono"
                    value={destination}
                    onChange={(e) => setDestination(e.target.value)}
                    placeholder="+91 98765 43210"
                    aria-invalid={(touched && !!errors.destination) || undefined}
                  />
                  {touched && errors.destination ? <p className="text-[0.8rem] font-medium text-destructive">{errors.destination}</p> : null}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="tester-source">Sender</Label>
                  <Input
                    id="tester-source"
                    className="font-mono"
                    value={source}
                    maxLength={16}
                    onChange={(e) => setSource(e.target.value)}
                    aria-invalid={(touched && !!errors.source) || undefined}
                  />
                  {touched && errors.source ? <p className="text-[0.8rem] font-medium text-destructive">{errors.source}</p> : null}
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="tester-text">Text</Label>
                <Textarea id="tester-text" value={text} onChange={(e) => setText(e.target.value)} rows={4} />
                <SmsCounter text={text} onFix={setText} />
              </div>
              {route?.template_mode && routeId ? <TemplatePreviewInline routeId={routeId} text={text} /> : null}
              <Button type="submit" disabled={send.isPending || (touched && invalid)} className="w-full">
                {send.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
                Send test
              </Button>
            </form>
            {lastError ? (
              <Alert variant="destructive">
                <AlertTitle className="font-mono">{isApiError(lastError) ? lastError.code : "Error"}</AlertTitle>
                <AlertDescription>{lastError.message}</AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
        </Card>

        <div className="space-y-6">
          {active ? (
            <ActiveTest
              key={active.id}
              entry={active}
              currency={currency}
              onUpdate={(r) => setHistory((h) => h.map((x) => (x.id === active.id ? { ...x, last: r } : x)))}
            />
          ) : (
            <Card>
              <EmptyState
                icon={<FlaskConical className="h-8 w-8" aria-hidden />}
                title="No test running"
                description="Send a test to see accepted → submitted → delivery report with latencies."
              />
            </Card>
          )}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Recent tests</CardTitle>
              <CardDescription>This browser session only.</CardDescription>
            </CardHeader>
            <CardContent>
              {history.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing yet.</p>
              ) : (
                <ul className="divide-y">
                  {history.map((h) => {
                    const st = h.last?.message.status ?? h.submit.status;
                    return (
                      <li key={h.id}>
                        <button
                          type="button"
                          onClick={() => setActiveId(h.id)}
                          className={cn(
                            "flex w-full flex-wrap items-center justify-between gap-2 px-2 py-2 text-left text-sm hover:bg-accent",
                            h.id === activeId && "bg-muted",
                          )}
                          aria-current={h.id === activeId || undefined}
                        >
                          <span className="min-w-0">
                            <span className="font-mono">{h.destination}</span>
                            <span className="text-muted-foreground"> via {h.route_name}</span>
                            <span className="block text-xs text-muted-foreground">{formatDateTime(new Date(h.sentAt).toISOString())}</span>
                          </span>
                          <span className="flex items-center gap-2">
                            {h.last?.timings.dlr_latency_ms !== null && h.last?.timings.dlr_latency_ms !== undefined ? (
                              <Badge variant="outline" className="tabular-nums">
                                DLR {formatLatency(h.last.timings.dlr_latency_ms)}
                              </Badge>
                            ) : null}
                            <StatusBadge status={st} />
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
