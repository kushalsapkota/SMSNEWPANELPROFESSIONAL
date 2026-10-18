/**
 * Copy-able examples for the public HTTP API (CONTRACTS §11) and webhook
 * signature verification (§2, §9). Pure string builders so they can be unit
 * tested and shown verbatim.
 */

export interface DocsContext {
  /** e.g. https://sms.example.com (no trailing slash) */
  baseUrl: string;
  apiKey: string;
  from: string;
  to: string;
}

const q = (s: string) => s.replace(/'/g, "'\\''");

export function curlSendPost(c: DocsContext): string {
  const body = JSON.stringify({ to: c.to, from: c.from, text: "Your code is 849201", client_ref: "order-1001" });
  return [
    `curl -X POST '${q(c.baseUrl)}/v1/sms/send' \\`,
    `  -H 'Authorization: Bearer ${q(c.apiKey)}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '${q(body)}'`,
  ].join("\n");
}

export function curlSendBulk(c: DocsContext): string {
  const body = JSON.stringify({ to: [c.to, "14155550100"], from: c.from, text: "Sale ends tonight!" });
  return [
    `curl -X POST '${q(c.baseUrl)}/v1/sms/send' \\`,
    `  -H 'X-API-Key: ${q(c.apiKey)}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '${q(body)}'`,
  ].join("\n");
}

export function curlSendGet(c: DocsContext): string {
  const params = new URLSearchParams({ api_key: c.apiKey, to: c.to, from: c.from, text: "Hello from the API" });
  return `curl '${q(c.baseUrl)}/v1/sms/send?${q(params.toString())}'`;
}

export function curlStatus(c: DocsContext): string {
  return [`curl '${q(c.baseUrl)}/v1/sms/MESSAGE_ID' \\`, `  -H 'Authorization: Bearer ${q(c.apiKey)}'`].join("\n");
}

export function curlBalance(c: DocsContext): string {
  return [`curl '${q(c.baseUrl)}/v1/balance' \\`, `  -H 'Authorization: Bearer ${q(c.apiKey)}'`].join("\n");
}

export const SEND_RESPONSE = `{
  "messages": [
    { "to": "919876543210", "message_id": "0192f1c4-…", "status": "ACCEPTED", "parts": 1, "cost_micros": 5000 },
    { "to": "14155550100", "error_code": "ROUTE_NOT_FOUND", "message": "No route for destination" }
  ]
}`;

export const STATUS_RESPONSE = `{
  "message_id": "0192f1c4-…",
  "to": "919876543210",
  "from": "MYBRAND",
  "status": "DELIVERED",
  "dlr_stat": "DELIVRD",
  "parts": 1,
  "cost_micros": 5000,
  "created_at": "2026-10-18T09:15:02.120Z",
  "submitted_at": "2026-10-18T09:15:02.311Z",
  "done_at": "2026-10-18T09:15:05.902Z",
  "client_ref": "order-1001"
}`;

export const BALANCE_RESPONSE = `{ "balance_micros": 125000000, "currency": "USD" }`;

export const ERROR_RESPONSE = `{ "error_code": "INSUFFICIENT_FUNDS", "message": "Insufficient balance" }`;

export const WEBHOOK_PAYLOAD = `POST <your webhook URL>
Content-Type: application/json
X-Webhook-Timestamp: 1760778905
X-Webhook-Signature: sha256=5d41402abc4b2a76b9719d911017c592…

{
  "event": "dlr",
  "message_id": "0192f1c4-…",
  "client_ref": "order-1001",
  "to": "919876543210",
  "from": "MYBRAND",
  "status": "DELIVERED",
  "dlr_stat": "DELIVRD",
  "dlr_err": "000",
  "parts": 1,
  "submitted_at": "2026-10-18T09:15:02.311Z",
  "done_at": "2026-10-18T09:15:05.902Z"
}`;

export const VERIFY_NODE = `// Node.js (Express) - verify X-Webhook-Signature over the RAW body
const crypto = require("node:crypto");
const express = require("express");

const SECRET = process.env.WEBHOOK_SECRET; // shown once when the webhook was created
const app = express();

app.post("/sms/dlr", express.raw({ type: "application/json" }), (req, res) => {
  const ts = req.get("X-Webhook-Timestamp") || "";
  const sig = req.get("X-Webhook-Signature") || "";
  if (!/^\\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) {
    return res.status(401).send("stale timestamp");
  }
  const expected =
    "sha256=" + crypto.createHmac("sha256", SECRET).update(ts + "." + req.body).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).send("bad signature");
  }
  const event = JSON.parse(req.body.toString("utf8"));
  console.log(event.message_id, event.status);
  res.sendStatus(200); // any 2xx stops retries
});

app.listen(8080);`;

export const VERIFY_PHP = `<?php
// PHP - verify X-Webhook-Signature over the raw request body
$secret = getenv('WEBHOOK_SECRET'); // shown once when the webhook was created
$ts   = $_SERVER['HTTP_X_WEBHOOK_TIMESTAMP'] ?? '';
$sig  = $_SERVER['HTTP_X_WEBHOOK_SIGNATURE'] ?? '';
$body = file_get_contents('php://input');

if (!ctype_digit($ts) || abs(time() - (int) $ts) > 300) {
    http_response_code(401);
    exit('stale timestamp');
}
$expected = 'sha256=' . hash_hmac('sha256', $ts . '.' . $body, $secret);
if (!hash_equals($expected, $sig)) {
    http_response_code(401);
    exit('bad signature');
}

$event = json_decode($body, true);
error_log($event['message_id'] . ' ' . $event['status']);
http_response_code(200); // any 2xx stops retries`;

export const VERIFY_PYTHON = `# Python (Flask) - verify X-Webhook-Signature over the raw request body
import hashlib, hmac, os, time
from flask import Flask, abort, request

SECRET = os.environ["WEBHOOK_SECRET"].encode()  # shown once when the webhook was created
app = Flask(__name__)

@app.post("/sms/dlr")
def dlr():
    ts = request.headers.get("X-Webhook-Timestamp", "")
    sig = request.headers.get("X-Webhook-Signature", "")
    if not ts.isdigit() or abs(time.time() - int(ts)) > 300:
        abort(401)
    body = request.get_data()  # raw bytes, before any JSON parsing
    expected = "sha256=" + hmac.new(SECRET, ts.encode() + b"." + body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        abort(401)
    event = request.get_json()
    print(event["message_id"], event["status"])
    return "", 200  # any 2xx stops retries`;

/** Reference implementation of the signature (CONTRACTS §2), used by tests to check the snippets' scheme. */
export function signaturePayload(timestamp: string, body: string): string {
  return `${timestamp}.${body}`;
}
