# Client APIs

Clients send messages over the **HTTP API** or **SMPP**. Both share the same routing, billing,
rate limits and delivery reports. The panel's *Developer* page (CLIENT role) shows each client
its own base URL, SMPP host and credentials.

Money is always in **micros**: 1 currency unit = 1,000,000.

## HTTP API (`/v1`)

Authenticate with an API key created in the panel (*Developer → API keys*):

```
Authorization: Bearer <api_key>        or        X-API-Key: <api_key>
```

Keys carry scopes: `sms:send`, `sms:read`, `balance:read`. Each key is limited to
`PUBLIC_API_RATE_LIMIT` requests per second. The account's IP whitelist, if set, applies.

### Send

```bash
curl -s https://panel.example.com/v1/sms/send \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: order-1234' \
  -d '{"to":"+9779800000000","from":"MYBRAND","text":"Your code is 482913","client_ref":"order-1234"}'
```

| Field | Type | Notes |
|---|---|---|
| `to` | string or string[] | One number, a comma-separated list, or an array of up to 1000. |
| `from` | string | Sender ID assigned to the account. |
| `text` | string | Up to 5000 chars; split into parts automatically (GSM-7 or UCS-2). |
| `client_ref` | string? | Your own reference (≤ 64 chars), echoed back in status and webhooks. |

`Idempotency-Key` (optional, ≤ 255 chars): repeating a request with the same key within 24 h never
sends or charges twice; it returns the original result.

Response `200`:

```json
{ "messages": [
  { "to": "9779800000000", "message_id": "uuid", "status": "ACCEPTED", "parts": 1, "cost_micros": 15000 },
  { "to": "123", "error_code": "INVALID_DESTINATION", "message": "..." }
] }
```

A single rejected recipient returns a `4xx`/`422` error body instead. `409` means the
`Idempotency-Key` was reused for a different request.

Legacy form (same response; the key in the query string is redacted from nginx logs):

```
GET /v1/sms/send?api_key=...&to=9779800000000,9779811111111&from=MYBRAND&text=Hello
```

### Status

```
GET /v1/sms/{message_id}
→ { message_id, to, from, status, dlr_stat, parts, cost_micros, created_at, submitted_at, done_at, client_ref }
```

Statuses: `ACCEPTED` → `QUEUED` → `SUBMITTED` → final `DELIVERED`, `UNDELIVERED`, `EXPIRED`,
`FAILED`, `REJECTED` or `UNKNOWN`. `FAILED` sends are refunded automatically.

### Balance

```
GET /v1/balance  →  { "balance_micros": 125000000, "currency": "USD" }
```

### Webhooks

Configure a URL in the panel to receive delivery reports as signed POSTs instead of polling.

## SMPP

| | |
|---|---|
| Host / port | Panel hostname (or `PUBLIC_SMPP_HOST`), port `2775` (plain). `3775` is SMPP over TLS when the nginx `stream` block is enabled. |
| Version | SMPP 3.4 |
| Bind types | transmitter, receiver, transceiver (per account: `allowed_bind_types`) |
| Credentials | `system_id` / password from the panel (*SMPP accounts*) |
| Limits | `max_binds` concurrent sessions and `max_tps` per account; IP whitelist applies |

`submit_sm` returns the gateway `message_id`; delivery receipts come back as `deliver_sm` on a
receiver/transceiver bind. Long messages may be sent as UDH or SAR concatenated parts, or in `message_payload`; parts are
reassembled before routing.

Test from the server (the engine image ships `smpp-cli`):

```bash
docker exec -it smsgw-engine-1 smpp-cli -addr 127.0.0.1:2775 -system-id <system_id> -password <password> -from DEMO -to 9779800000000 -text "hi"
```

## Management API (`/api`)

The panel itself uses `/api/*` (JWT auth). With `SWAGGER_ENABLED=1` the full OpenAPI reference is at
`/api/docs`. It is always blocked at the public nginx edge; reach it over the VPN or an SSH tunnel.
The full contract is in [CONTRACTS.md](../CONTRACTS.md) §11 and
[CONTRACTS-CHANGES.md](../CONTRACTS-CHANGES.md).
