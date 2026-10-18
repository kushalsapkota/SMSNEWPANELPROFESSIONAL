"use client";

import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Send } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CopyField } from "@/components/shared/copy-button";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { api, errorMessage, qk } from "@/lib/api";
import type { ConnectionTestResponse } from "@/lib/api/types";
import { describeHttpError } from "@/lib/carrier-status";
import { callbackUrl } from "@/lib/http-adapters";

/** Destination check for the test dialog: digits with an optional +, 6-15 digits. */
export function testDestinationError(to: string): string | null {
  const digits = to.replace(/[\s()-]/g, "");
  if (!digits) return "Enter a phone number";
  return /^\+?[0-9]{6,15}$/.test(digits) ? null : "Digits only, e.g. 98XXXXXXXX";
}

function bodyText(b: unknown): string {
  if (b === null || b === undefined || b === "") return "(empty)";
  return typeof b === "string" ? b : JSON.stringify(b, null, 2);
}

export function TestSendResult({ r }: { r: ConnectionTestResponse }) {
  const plain = r.ok ? null : describeHttpError(r.error);
  return (
    <div className="space-y-3 text-sm" data-testid="test-send-result">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={r.ok ? "success" : "destructive"}>{r.ok ? "Accepted by the provider" : "Failed"}</Badge>
        {r.http_status !== null ? <span className="text-muted-foreground">HTTP {r.http_status}</span> : null}
        {r.duration_ms !== null ? <span className="text-muted-foreground">{r.duration_ms} ms</span> : null}
        {r.provider_message_id ? <span className="text-muted-foreground">Provider id: <code>{r.provider_message_id}</code></span> : null}
      </div>
      {!r.ok && r.error ? (
        <p className="text-destructive">
          {plain}
          {plain !== r.error ? <span className="block font-mono text-xs text-muted-foreground">{r.error}</span> : null}
        </p>
      ) : null}
      {r.request ? (
        <div className="space-y-1">
          <p className="font-medium">Request (secrets masked)</p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs">
            {`${r.request.method} ${r.request.url}\n\n${bodyText(r.request.body)}`}
          </pre>
        </div>
      ) : null}
      <div className="space-y-1">
        <p className="font-medium">Response</p>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs">{bodyText(r.response_body)}</pre>
      </div>
    </div>
  );
}

/** "Send test SMS": ONE real message through this connection (outside billing), then the masked exchange. */
export function TestSendDialog({ connectionId, name, open, onOpenChange }: { connectionId: string; name: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [to, setTo] = useState("");
  const [text, setText] = useState("Test message from the SMS gateway");
  const [touched, setTouched] = useState(false);
  const test = useApiMutation({
    mutationFn: (body: { to: string; text: string }) => api.connections.test(connectionId, body),
    success: false,
    errorTitle: "Test send failed",
    invalidate: [qk.routes.all],
  });
  useEffect(() => {
    if (!open) {
      test.reset();
      setTouched(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const toError = touched ? testDestinationError(to) : null;
  const textError = touched && !text.trim() ? "Enter a message" : null;
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (testDestinationError(to) || !text.trim()) return;
    test.mutate({ to: to.replace(/[\s()-]/g, ""), text });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Send test SMS via {name}</DialogTitle>
          <DialogDescription>Sends one real message through this provider. It is not billed to anyone and does not appear in reports.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-3" noValidate aria-label="Send test SMS">
          <div className="space-y-1">
            <Label htmlFor="test-to">To</Label>
            <Input id="test-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="98XXXXXXXX" inputMode="tel" aria-invalid={!!toError} />
            {toError ? <p className="text-sm font-medium text-destructive">{toError}</p> : null}
          </div>
          <div className="space-y-1">
            <Label htmlFor="test-text">Message</Label>
            <Textarea id="test-text" value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={1600} aria-invalid={!!textError} />
            {textError ? <p className="text-sm font-medium text-destructive">{textError}</p> : null}
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={test.isPending}>
              <Send /> {test.isPending ? "Sending…" : "Send test"}
            </Button>
          </div>
        </form>
        {test.data ? <TestSendResult r={test.data} /> : test.error ? <p className="text-sm text-destructive">{errorMessage(test.error)}</p> : null}
      </DialogContent>
    </Dialog>
  );
}

/** Provider credit as the provider reports it, with a refresh button (fetched once, not polled). */
export function ProviderBalance({ connectionId }: { connectionId: string }) {
  const q = useQuery({
    queryKey: qk.connections.balance(connectionId),
    queryFn: () => api.connections.balance(connectionId),
    staleTime: Infinity,
    retry: false,
  });
  const value = q.isLoading
    ? "…"
    : q.isError
      ? `unavailable (${errorMessage(q.error)})`
      : !q.data?.supported
        ? "not available for this provider"
        : q.data.error
          ? `unavailable (${q.data.error})`
          : (q.data.balance ?? "unknown");
  return (
    <span className="inline-flex items-center gap-1 text-sm" data-testid="provider-balance">
      <span className="text-muted-foreground">Provider balance:</span> <span className="font-medium tabular-nums">{value}</span>
      <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => q.refetch()} disabled={q.isFetching} aria-label="Refresh provider balance">
        <RefreshCw className={q.isFetching ? "animate-spin" : undefined} />
      </Button>
    </span>
  );
}

/** Provider DLR callback URL to paste into the provider's dashboard, with copy. */
export function DlrCallbackUrl({ connection }: { connection: { dlr_callback_url?: string | null; dlr_callback_path?: string | null } }) {
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const url = callbackUrl({ dlr_callback_url: connection.dlr_callback_url ?? null, dlr_callback_path: connection.dlr_callback_path ?? null }, origin);
  if (!url) return null;
  return (
    <div className="space-y-1" data-testid="dlr-callback-url">
      <p className="text-xs text-muted-foreground">Delivery report URL: paste it into the provider&apos;s dashboard (keep it secret).</p>
      <CopyField value={url} />
    </div>
  );
}
