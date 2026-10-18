"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Panel } from "@/components/credentials";
import { CopyField } from "@/components/shared/copy-button";
import {
  BALANCE_RESPONSE,
  ERROR_RESPONSE,
  SEND_RESPONSE,
  STATUS_RESPONSE,
  VERIFY_NODE,
  VERIFY_PHP,
  VERIFY_PYTHON,
  WEBHOOK_PAYLOAD,
  curlBalance,
  curlSendBulk,
  curlSendGet,
  curlSendPost,
  curlStatus,
} from "@/lib/api-docs";
import { CodeBlock, CodeTabs } from "./code-block";

/** Public base URL for /v1 (build-time override, else this panel's origin; the panel proxies /v1). */
export function usePublicBaseUrl(): string {
  const [base, setBase] = useState(process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, "") ?? "");
  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_API_BASE_URL) setBase(window.location.origin);
  }, []);
  return base || "https://your-gateway.example.com";
}

const ERRORS: Array<[string, string, string]> = [
  ["400", "INVALID_REQUEST", "Malformed body, missing field"],
  ["401", "UNAUTHORIZED", "Missing / invalid / revoked key"],
  ["403", "IP_NOT_ALLOWED", "Caller IP not in the API whitelist"],
  ["422", "ACCOUNT_SUSPENDED · SENDING_DISABLED · CHANNEL_DISABLED", "Account or HTTP API disabled"],
  ["422", "INSUFFICIENT_FUNDS", "Balance (plus credit limit) too low"],
  ["422", "INVALID_DESTINATION", "Not 6-15 digits after stripping + spaces dashes"],
  ["422", "ROUTE_NOT_FOUND", "No route covers the destination"],
  ["422", "SENDER_NOT_ALLOWED", "Sender ID not approved"],
  ["422", "DESTINATION_BLOCKED · CONTENT_BLOCKED", "Blocklisted number / keyword"],
  ["422", "MESSAGE_TOO_LONG", "More than 10 parts"],
  ["422", "OTP_NOT_FOUND", "Template route found no OTP and rejects"],
  ["422", "DAILY_LIMIT · MONTHLY_LIMIT", "Volume cap reached"],
  ["429", "RATE_LIMITED", "Over your TPS or 100 req/s per key"],
];

/** HTTP API reference with copy-able curl examples and webhook verification snippets. */
export function ApiDocs({ defaultFrom = "MYBRAND" }: { defaultFrom?: string }) {
  const baseUrl = usePublicBaseUrl();
  const [apiKey, setApiKey] = useState("");
  const [to, setTo] = useState("919876543210");
  const [from, setFrom] = useState(defaultFrom);
  const ctx = { baseUrl, apiKey: apiKey.trim() || "sk_live_YOUR_API_KEY", to: to.trim() || "919876543210", from: from.trim() || "MYBRAND" };

  return (
    <div className="space-y-6">
      <Panel title="HTTP API" description="JSON over HTTPS. Money is in micros (1 unit = 1,000,000).">
        <div className="space-y-4">
          <div className="space-y-1">
            <Label>Base URL</Label>
            <CopyField value={`${baseUrl}/v1`} />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="docs-key">Fill examples with your key</Label>
              <Input
                id="docs-key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk_live_…"
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">Stays in this page; never sent anywhere.</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="docs-to">To</Label>
              <Input id="docs-to" value={to} onChange={(e) => setTo(e.target.value)} className="font-mono" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="docs-from">From</Label>
              <Input id="docs-from" value={from} onChange={(e) => setFrom(e.target.value)} className="font-mono" />
            </div>
          </div>
          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            <p className="font-medium">Authentication</p>
            <p className="text-muted-foreground">
              Send your key as <code className="font-mono">Authorization: Bearer sk_live_…</code> or{" "}
              <code className="font-mono">X-API-Key: sk_live_…</code>. The legacy GET endpoint also accepts{" "}
              <code className="font-mono">?api_key=</code>. Requests from IPs outside your API whitelist are refused.
            </p>
          </div>
        </div>
      </Panel>

      <Panel title="Send SMS" description="POST /v1/sms/send · up to 1,000 recipients per request.">
        <div className="space-y-4">
          <Endpoint method="POST" path="/v1/sms/send" />
          <CodeBlock label="Single recipient" code={curlSendPost(ctx)} />
          <CodeBlock label="Several recipients" code={curlSendBulk(ctx)} />
          <p className="text-sm text-muted-foreground">
            Body: <code className="font-mono">to</code> (string or array), <code className="font-mono">from</code>,{" "}
            <code className="font-mono">text</code>, optional <code className="font-mono">client_ref</code> (echoed in delivery
            reports). Encoding (GSM-7 / UCS-2) and splitting into parts are automatic.
          </p>
          <CodeBlock label="Response 200" code={SEND_RESPONSE} />
          <p className="text-sm text-muted-foreground">
            With several recipients the response is always 200 with one row per recipient. A single-recipient request that is
            rejected returns the HTTP error with the error body:
          </p>
          <CodeBlock label="Error (e.g. 422)" code={ERROR_RESPONSE} />
          <Endpoint method="GET" path="/v1/sms/send?api_key=&to=&from=&text=&client_ref=" />
          <CodeBlock label="Legacy GET" code={curlSendGet(ctx)} />
        </div>
      </Panel>

      <Panel title="Status & balance">
        <div className="space-y-4">
          <Endpoint method="GET" path="/v1/sms/:message_id" />
          <CodeBlock label="Message status" code={curlStatus(ctx)} />
          <CodeBlock label="Response 200" code={STATUS_RESPONSE} />
          <Endpoint method="GET" path="/v1/balance" />
          <CodeBlock label="Balance" code={curlBalance(ctx)} />
          <CodeBlock label="Response 200" code={BALANCE_RESPONSE} />
        </div>
      </Panel>

      <Panel title="Errors" description="Every error has the shape { error_code, message }.">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">API error codes</caption>
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-3 font-medium">HTTP</th>
                <th className="py-2 pr-3 font-medium">error_code</th>
                <th className="py-2 font-medium">Meaning</th>
              </tr>
            </thead>
            <tbody>
              {ERRORS.map(([status, code, meaning]) => (
                <tr key={code} className="border-b last:border-0">
                  <td className="py-2 pr-3 tabular-nums">{status}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{code}</td>
                  <td className="py-2 text-muted-foreground">{meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        title="Delivery report webhooks"
        description="Configure a webhook in the Webhooks tab; delivery reports are POSTed as they arrive."
      >
        <div className="space-y-4">
          <CodeBlock label="Request" code={WEBHOOK_PAYLOAD} />
          <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
            <p>
              Signature: <code className="font-mono">sha256=hex(HMAC_SHA256(secret, timestamp + &quot;.&quot; + raw_body))</code>. Compute
              it over the raw bytes before parsing JSON, compare in constant time, and reject timestamps older than 5 minutes.
            </p>
            <p className="mt-1">
              Answer with any 2xx within the timeout. Other responses are retried with exponential backoff (10s × 2ⁿ) up to the
              webhook&apos;s max retries; every attempt is logged in the delivery log.
            </p>
          </div>
          <CodeTabs
            label="Verify signature"
            snippets={[
              { lang: "Node.js", code: VERIFY_NODE },
              { lang: "PHP", code: VERIFY_PHP },
              { lang: "Python", code: VERIFY_PYTHON },
            ]}
          />
        </div>
      </Panel>
    </div>
  );
}

function Endpoint({ method, path }: { method: string; path: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={method === "POST" ? "default" : "secondary"} className="font-mono">
        {method}
      </Badge>
      <code className="break-all font-mono text-sm">{path}</code>
    </div>
  );
}
