# CONTRACTS: the single source of truth between components

Every component is built in parallel against this file. If you need to deviate, you must
(a) keep the deviation backward compatible and (b) document it in `CONTRACTS-CHANGES.md`.

## 0. Repo layout & ownership

```
db/migrations/      SQL (canonical schema; 001-004 exist; READ THEM before writing queries)
redis/lua/          canonical balance Lua scripts (debit/refund/credit/load) — see README.md
engine/             Go 1.23 module `smsgw/engine`  — SMPP, routing, templating, billing, DLR, CDR
api/                NestJS 10 + TypeScript (Kysely + pg) — auth, management REST, public HTTP API
web/                Next.js 14 App Router + Tailwind + shadcn/ui + TanStack Query — panel UI
deploy/             Dockerfiles, docker-compose, seed, e2e scripts
```

Agents MUST NOT run `git commit` / `git add` (the orchestrator commits). Stay inside your
owned directories unless told otherwise.

## 1. Ports, env, local dev services

| Service | Port | Notes |
|---|---|---|
| Postgres 16 | 5432 | local superuser `postgres` via `su postgres -c psql`; create your OWN db (`sms_<yourname>`) for tests |
| Redis 7 | 6399 | use your assigned DB index (engine-core: 1, engine-flow: 2, integration: 3, api: 4, lua tests: 15) |
| api (NestJS) | 3000 | mgmt REST under `/api/*`, public under `/v1/*` |
| web (Next.js) | 3001 | rewrites `/api/*` and `/v1/*` to the api |
| engine internal HTTP | 8081 | only reachable by api; header `X-Internal-Token: $INTERNAL_TOKEN` |
| engine client SMPP server | 2775 | clients bind here |
| engine metrics (Prometheus text) | 9100 | `/metrics` |
| smsc-sim (fake upstream) | 2776 | `engine/cmd/smsc-sim` — for tests / e2e |

**Test databases:** `db/reset-db.sh <dbname>` creates a fresh, fully migrated DB plus dev logins:
tenant/RLS `postgres://sms_api_login:sms_api_dev@localhost:5432/<db>`,
engine/privileged (BYPASSRLS) `postgres://sms_engine_login:sms_engine_dev@localhost:5432/<db>`.
Use your own db name. Never touch other agents' DBs or Redis DB indexes.

Env vars (both api and engine read the same names):
```
DATABASE_URL          postgres://... (engine: role with sms_engine; api tenant pool: role with sms_api)
DATABASE_URL_PRIVILEGED  api only: role with sms_engine (BYPASSRLS) — auth + background jobs only
REDIS_URL             redis://localhost:6399/0
INTERNAL_TOKEN        shared secret api <-> engine
ENGINE_URL            api only: http://localhost:8081
APP_ENC_KEY           base64 of 32 random bytes — AES-256-GCM for *_enc columns
JWT_SECRET            api only
```

## 2. Shared crypto formats (Node and Go MUST interoperate)

- **`*_enc` columns** (`upstream_connections.password_enc`, `webhooks.secret_enc`, `users.totp_secret_enc` (bytea: store the UTF-8 bytes of the same string)):
  string `v1:` + base64std( nonce(12 bytes) || ciphertext || tag(16 bytes) ), AES-256-GCM, key = base64-decoded `APP_ENC_KEY`, no AAD.
- **Passwords** (`users.password_hash`, `smpp_accounts.password_hash`): argon2id PHC string,
  `$argon2id$v=19$m=19456,t=2,p=1$<b64 salt no padding>$<b64 hash no padding>`, 16-byte salt, 32-byte hash.
  Node: `@node-rs/argon2`. Go: `golang.org/x/crypto/argon2` + PHC parsing. Go caches successful SMPP bind verifications in memory (keyed by sha256(system_id|password|password_hash)) for 10 min.
- **API keys**: `sk_live_` + 40 chars base62 (crypto random). `key_prefix` = first 12 chars. `key_hash` = sha256(full key) raw bytes.
- **Webhook signature**: headers `X-Webhook-Timestamp: <unix seconds>`, `X-Webhook-Signature: sha256=<hex(hmac_sha256(secret, timestamp + "." + body))>`.

## 3. Money, numbers, text

- Money is integer **micros** everywhere (`*_micros`), JSON numbers.
- MSISDNs are stored/compared as digits only, E.164 without `+` (`919876543210`). Inputs may have `+`, spaces, dashes: strip them; reject anything left that's not 6-15 digits.
- Sender: alphanumeric (≤11 chars, contains a letter) → TON 5 NPI 0; numeric ≥ 9 digits → TON 1 NPI 1 (strip `+`); numeric ≤ 8 digits (short code) → TON 3 NPI 0.
- Encoding: GSM-7 if every char is in GSM 03.38 basic + extension table (extension chars count as 2 septets); else UCS-2. Parts: GSM7 ≤160 → 1 else ceil(n/153); UCS2 ≤70 → 1 else ceil(n/67) (count UTF-16 code units). Max 10 parts else `MESSAGE_TOO_LONG`.

## 4. Error codes (shared enum; HTTP API returns these as `error_code`)

```
INVALID_REQUEST  UNAUTHORIZED  FORBIDDEN  IP_NOT_ALLOWED  ACCOUNT_SUSPENDED  SENDING_DISABLED
CHANNEL_DISABLED INSUFFICIENT_FUNDS  RATE_LIMITED  DAILY_LIMIT  MONTHLY_LIMIT  ROUTE_NOT_FOUND
SENDER_NOT_ALLOWED  OTP_NOT_FOUND  DESTINATION_BLOCKED  CONTENT_BLOCKED  INVALID_DESTINATION
MESSAGE_TOO_LONG  NOT_FOUND  CONFLICT  INTERNAL
```
SMPP mapping (engine): INSUFFICIENT_FUNDS/OTP_NOT_FOUND/ROUTE_NOT_FOUND/DESTINATION_BLOCKED/CONTENT_BLOCKED → `ESME_RSUBMITFAIL 0x45`; RATE_LIMITED/DAILY_LIMIT/MONTHLY_LIMIT → `ESME_RTHROTTLED 0x58`; SENDER_NOT_ALLOWED → `ESME_RINVSRCADR 0x0A`; INVALID_DESTINATION → `ESME_RINVDSTADR 0x0B`; MESSAGE_TOO_LONG → `ESME_RINVMSGLEN 0x01`; ACCOUNT_SUSPENDED/SENDING_DISABLED/CHANNEL_DISABLED → `ESME_RINVSYSID 0x0F` at bind, `ESME_RSUBMITFAIL` on submit; bad password `ESME_RINVPASWD 0x0E`; IP_NOT_ALLOWED → `ESME_RBINDFAIL 0x0D`.

## 5. Engine internal HTTP API (engine serves, api calls) — JSON, `X-Internal-Token` required

### `POST /internal/v1/submit`
```json
{ "org_id": "uuid", "channel": "HTTP|WEB", "source": "MYBANK", "destination": "+91 98765 43210",
  "text": "Ur code 849201", "client_ref": "abc-1"?, "campaign_id": "uuid"?,
  "route_id": "uuid"?,          // optional: force a route (must be assigned to org) — used by tester
  "test": false                  // true: admin/reseller tester; skips billing for SUPER_ADMIN only
}
```
200 `{ "message_id": "uuid", "status": "ACCEPTED", "parts": 1, "encoding": "GSM7", "cost_micros": 5000, "route_id": "uuid", "sent_text": "Your code is 849201..." }`
4xx `{ "error_code": "INSUFFICIENT_FUNDS", "message": "human text" }` (422 for business rejections, 400 for INVALID_REQUEST)

### `POST /internal/v1/submit/batch`
`{ "items": [ <submit body>, ... up to 1000 ] }` → `{ "results": [ <200 body> | {"error_code","message"} ... ] }` (same order)

### `POST /internal/v1/template/preview`
`{ "text": "...", "route_id": "uuid"?, "org_id": "uuid"?, "template": { "extract_patterns": [..], "otp_min_len": 4, "otp_max_len": 8, "template_body": "...{otp}...", "default_body": null, "fallback_action": "SEND_RAW", "brand": "Acme" }? }`
(either `template` inline, or `route_id` (+ optional `org_id`) to resolve the effective template exactly like the pipeline)
→ `{ "otp": "849201"|null, "matched_pattern": "...", "action": "TEMPLATED|SEND_RAW|REJECT|SEND_DEFAULT_TEMPLATE", "output": "final text"|null, "encoding": "GSM7", "parts": 1, "template_id": "uuid"|null }`

### `GET /internal/v1/connections/status`
→ `{ "connections": [ { "connection_id", "name", "enabled", "state": "BOUND|CONNECTING|DOWN|DISABLED", "sessions": [ { "index": 0, "state": "BOUND_TRX|CONNECTING|DOWN", "bound_since": "iso"|null, "last_error": "..."|null } ], "tps_limit": 100, "tps_current": 12.5, "inflight": 3, "queue_depth": 40, "submitted_total": 0, "failed_total": 0 } ] }`

### `GET /internal/v1/smpp/sessions` → `{ "sessions": [ { "session_id", "org_id", "system_id", "bind_type", "remote_addr", "bound_since", "tps_current", "submitted_total" } ] }`
### `POST /internal/v1/smpp/sessions/kick` `{ "org_id": "uuid" }` → `{ "kicked": 2 }` (unbinds all sessions of org — called after suspend / SMPP disable / password rotate)
### `POST /internal/v1/balance/credit` `{ "org_id", "delta_micros", "idempotency_key" }` → `{ "status": "OK|DUPLICATE|NOT_LOADED", "balance_micros": n|null }` — engine runs credit.lua with correct hash-tagged key
### `GET /internal/v1/balance/:org_id` → `{ "balance_micros": n, "credit_limit_micros": n, "loaded": true }` (hydrates if absent)
### `GET /internal/v1/health` → `{ "ok": true, "db": true, "redis": true }`

## 6. Config invalidation (api → engine)

After ANY write to organizations, routes, route_connections, upstream_connections, upstream_rates,
route_templates, org_route_assignments, sender_ids, smpp_accounts, ip_whitelists, webhooks,
blocked_numbers, blocked_keywords, accounts_balance (limit/mode changes), the api publishes on
Redis channel **`cfg:invalidate`** JSON `{"entity": "<table name>", "id": "<uuid or null>"}`.
The engine reloads that entity (it also does a full reload every 60s as a safety net).
Changing an upstream connection makes the engine rebind it.

Balance changes (topup/adjust) go through `POST /internal/v1/balance/credit` after the ledger row
is inserted (then the api sets `applied_at`). On `NOT_LOADED`, the api also updates
`accounts_balance.balance_micros += delta` (hydration will pick it up). On `OK`, do NOT touch
`accounts_balance.balance_micros` (the engine's syncer owns it while loaded).

## 7. Redis keys (engine-owned unless noted)

```
{t:<reseller_id>}:bal:<org_id>         balance hash (Lua scripts). Reseller's own key uses its own id as tag.
{t:<reseller_id>}:txn:<message_id>     debit record
{t:<reseller_id>}:credit:<idem>        topup idempotency
cfg:invalidate                         pubsub channel (api publishes)
rl:org:<org_id>:<unix_sec>             per-org TPS counter
cnt:d:<org_id>:<YYYYMMDD> / cnt:m:<org_id>:<YYYYMM>   daily / monthly message counters
dlrmap:<connection_id>:<smsc_msg_id>   → "<message_id>|<part_index>|<created_at_unix_ms>"   TTL 72h
msg:<message_id>                       hash: org_id, reseller_id, channel, parts, delivered, failed, created_at_ms, client_ref, smpp_system_id   TTL 72h
q:dispatch:<route_id>                  Redis Stream, consumer group "dispatch"
q:dlr-out                              Redis Stream of client DLR deliveries (webhook / SMPP)
```
Balance hash tag rule: for a CLIENT the tag is its reseller's id; for a RESELLER the tag is its own id.
SUPER_ADMIN is never billed.

## 8. Billing rules (engine pipeline)

- Client rate = client's matched assignment `rate_micros` × parts. Reseller rate = reseller's assignment for the same route with longest prefix that matches the destination × parts. Debit both via debit.lua in one call (client key first, reseller second). If a RESELLER sends itself, single debit.
- Route cost (for analytics) = `upstream_rates` longest-prefix for the connection actually used × parts; recorded at submit time.
- Refund (refund.lua) when: rejected after debit, all connections failed / submit_sm_resp error, or `FAILED` status before submission. DLR `UNDELIV`/`EXPIRED` are NOT refunded (carrier charged us) — configurable later.

## 9. Routing & policy (engine pipeline, in order)

1. Org effective state (`app.org_effective_state`): `can_send` + channel flag (`can_api` for HTTP/WEB? — WEB requires `web_enabled`; HTTP requires `api_enabled`; SMPP requires `smpp_enabled`).
2. Normalize destination → INVALID_DESTINATION.
3. Blocked numbers (global, reseller's, client's; prefix match) → DESTINATION_BLOCKED. Blocked keywords → CONTENT_BLOCKED.
4. Route: client's enabled assignments whose `prefix` is a prefix of the destination; pick longest prefix, then lowest `priority`. Route must be enabled with ≥1 enabled connection. `route_id` in request restricts candidates. None → ROUTE_NOT_FOUND.
5. Sender: `routes.force_sender_id` overrides. Else if the org has any `sender_ids` rows, source must match an APPROVED row (route-specific or route NULL) → SENDER_NOT_ALLOWED. No rows = any sender.
6. Template (if `routes.template_mode`): effective template = active template with (route_id, org_id=client) else (route_id, org_id NULL). Try `extract_patterns` in order (RE2); the first match whose length is within [otp_min_len, otp_max_len] wins. Render `template_body` replacing `{otp}`, `{brand}` (template.brand → client brand_name → reseller brand_name → ""), `{sender}`. No OTP → fallback (`template.fallback_action` ?? `routes.template_fallback`): REJECT → OTP_NOT_FOUND; SEND_RAW → original; SEND_DEFAULT_TEMPLATE → `default_body` with same vars.
7. Encoding/parts on the FINAL text → MESSAGE_TOO_LONG.
8. Rate limits: per-org TPS (`effective_max_tps`, SMPP account max_tps if lower) → RATE_LIMITED; daily/monthly → DAILY_LIMIT/MONTHLY_LIMIT.
9. Debit → INSUFFICIENT_FUNDS.
10. Persist CDR (`message_logs`, status ACCEPTED, original + sent text), Redis msg state, enqueue `q:dispatch:<route_id>`; respond.

Dispatcher: per connection token-bucket = `max_tps`; window = `window_size` per session; pick connection by lowest priority with a BOUND session, weighted random among equal priority; on submit error/timeout, try next connection (max 2 failovers) then FAILED + refund. Multipart: UDH (8-bit ref) by default, SAR TLVs if `multipart_mode=SAR`, `message_payload` TLV if `PAYLOAD`.

DLR: upstream `deliver_sm` with esm_class receipt bit → parse `id:` (or TLV `receipted_message_id` 0x001E, `message_state` 0x0427) → `dlrmap` → message. Multipart final status: DELIVERED only if all parts delivered; otherwise the worst final part status once all parts are final. Map stat: DELIVRD→DELIVERED, UNDELIV→UNDELIVERED, EXPIRED→EXPIRED, REJECTD→REJECTED, DELETED/UNKNOWN→UNKNOWN, ACCEPTD→ (ignore, not final). Then forward to client: SMPP client (if session for that system_id bound with RX/TRX) gets `deliver_sm` receipt `id:<message_id> sub:001 dlvrd:00X submit date:YYMMDDhhmm done date:YYMMDDhhmm stat:DELIVRD err:000 text:<first 20 chars>` with esm_class 0x04 and TLVs 0x001E/0x0427; HTTP clients with enabled webhook subscribed to `dlr` get POST:
```json
{ "event": "dlr", "message_id": "uuid", "client_ref": "abc-1"|null, "to": "919876543210", "from": "MYBANK",
  "status": "DELIVERED", "dlr_stat": "DELIVRD", "dlr_err": "000", "parts": 1, "submitted_at": "iso", "done_at": "iso" }
```
retry with exponential backoff 10s·2^n up to `max_retries`, log every attempt in `webhook_deliveries`.

## 10. Management REST API (api serves, web calls) — prefix `/api`

Auth: `Authorization: Bearer <access JWT>` (15 min). JWT claims: `sub` user id, `org` acting org id, `role` acting org role, `imp` impersonator user id (optional), `oid` original org id (when impersonating).
Every list endpoint: `?page=1&page_size=50` → `{ "items": [...], "total": n, "page": 1, "page_size": 50 }`. Messages use cursor pagination instead (`?cursor=` → `{items, next_cursor}`).
Errors: `{ "error_code": "...", "message": "...", "details"?: {...} }` with proper HTTP status.
"Scoped" endpoints accept `?org_id=` so an admin/reseller can act on a child org; default = acting org. Authorization: admin may act on resellers (and read-only on their clients); reseller may act on its clients; client on itself.

```
POST /api/auth/login            {email, password, totp_code?} → {access_token, refresh_token, user, org} | 401 | {requires_totp:true}
POST /api/auth/refresh          {refresh_token} → {access_token, refresh_token}
POST /api/auth/logout           {refresh_token}
GET  /api/auth/me               → {user, org, impersonating: bool, original_org?}
POST /api/auth/password         {current_password, new_password}
POST /api/auth/totp/setup       → {secret, otpauth_url}
POST /api/auth/totp/enable      {code} → {recovery_codes: [..10]}
POST /api/auth/totp/disable     {code}
POST /api/auth/impersonate      {org_id} → {access_token, refresh_token}   (parent only; audited)
POST /api/auth/impersonate/stop → {access_token, refresh_token}

GET    /api/orgs                ?role=RESELLER|CLIENT&q=&status=  (admin: resellers (+?parent_id for clients), reseller: its clients)
POST   /api/orgs                {name, email, password, full_name?, brand_name?, max_tps?, daily_limit?, monthly_limit?, billing_mode?, credit_limit_micros?, currency?}  → creates org (child of acting org, role implied), owner user, accounts_balance
GET    /api/orgs/:id            → org + effective state + balance summary + counts
PATCH  /api/orgs/:id            {name?, brand_name?, max_tps?, daily_limit?, monthly_limit?, timezone?, whitelabel_domain?}
POST   /api/orgs/:id/suspend    {reason}      → also kicks SMPP sessions
POST   /api/orgs/:id/activate
PATCH  /api/orgs/:id/channels   {sending_enabled?, api_enabled?, smpp_enabled?, web_enabled?}
GET    /api/orgs/:id/users      ; POST /api/orgs/:id/users {email,password,full_name}
POST   /api/orgs/:id/users/:uid/reset-password {new_password} ; PATCH /api/orgs/:id/users/:uid {is_active}
GET    /api/orgs/:id/balance    → {balance_micros, credit_limit_micros, billing_mode, currency, low_balance_alert_micros}
POST   /api/orgs/:id/balance/topup   {amount_micros>0, note?}
POST   /api/orgs/:id/balance/adjust  {amount_micros (signed), note}
PATCH  /api/orgs/:id/billing    {billing_mode?, credit_limit_micros?, low_balance_alert_micros?}
GET    /api/orgs/:id/transactions
GET    /api/orgs/:id/routes     → assignments [{id, route_id, route_name, prefix, rate_micros, priority, enabled, parent_rate_micros}]
PUT    /api/orgs/:id/routes     [{route_id, prefix, rate_micros, priority, enabled}]  (replace set; admin→reseller, reseller→client)

# admin only
GET/POST /api/connections ; GET/PATCH/DELETE /api/connections/:id   (password write-only; never returned)
GET/PUT  /api/connections/:id/rates   [{prefix, cost_micros}]
GET/POST /api/routes ; GET/PATCH/DELETE /api/routes/:id   (GET /api/routes for reseller/client = assigned routes, name + id + template_mode only)
PUT      /api/routes/:id/connections  [{connection_id, priority, weight, enabled}]
GET      /api/monitor/connections     (proxy engine status)
GET      /api/monitor/smpp-sessions   (admin: all; reseller: its clients'; client: own)

# templates (admin: route-wide; reseller: per-client override for its clients; client: read-only own effective)
GET/POST /api/templates   ?route_id=&org_id=      ; GET/PATCH/DELETE /api/templates/:id
POST     /api/templates/preview   (proxy engine /template/preview)

# scoped (?org_id=)
GET/POST /api/sender-ids ; DELETE /api/sender-ids/:id ; POST /api/sender-ids/:id/approve|reject   (parent approves)
GET/POST /api/api-keys   (POST returns {key} once) ; DELETE /api/api-keys/:id (revoke)
GET/POST /api/smpp-accounts {system_id, password(≤8), max_binds?, max_tps?, allowed_bind_types?} ; PATCH/DELETE /api/smpp-accounts/:id ; POST /api/smpp-accounts/:id/password {password}
GET/POST /api/ip-whitelist {cidr, scope, note?} ; DELETE /api/ip-whitelist/:id
GET/POST /api/webhooks {url, events?, max_retries?} (POST returns {secret} once) ; PATCH/DELETE /api/webhooks/:id ; POST /api/webhooks/:id/test ; GET /api/webhooks/:id/deliveries
GET/POST /api/blocklist/numbers ; DELETE /api/blocklist/numbers/:id ; GET/POST /api/blocklist/keywords ; DELETE /api/blocklist/keywords/:id
GET/PUT  /api/notifications/settings

# messaging & reports (scoped; reseller without org_id = all its clients; admin = everything)
POST /api/messages/send        {to: string | string[] (≤1000), from, text, route_id?}   (web quick send, channel WEB)
GET  /api/messages             ?from_date&to_date&status&destination&source&route_id&org_id&channel&q&cursor&limit
GET  /api/messages/:id
GET  /api/messages/export      same filters → text/csv stream (max 1,000,000 rows)
GET  /api/analytics/summary    ?from&to&org_id&route_id → {messages, parts, delivered, failed, pending, delivery_rate, revenue_micros, cost_micros, profit_micros}
GET  /api/analytics/timeseries ?from&to&granularity=hour|day&org_id&route_id → {points:[{t, messages, delivered, failed, revenue_micros}]}
GET  /api/analytics/breakdown  ?by=route|country|org|status&from&to → {rows:[{key, label, messages, delivered, failed, delivery_rate, revenue_micros, cost_micros}]}
GET  /api/analytics/live       → {tps_in, tps_out, queue_depth, connections_up, connections_total}  (admin)  (from engine metrics/status)
POST /api/tester/send          {route_id, destination, text, source} → submit with test=true; returns {message_id,...}
GET  /api/tester/:message_id   → message + timings {accepted_at, submitted_at, dlr_received_at, submit_latency_ms, dlr_latency_ms}
POST /api/campaigns            multipart (file CSV with header incl. "phone" column, name, source_addr, body, scheduled_at?) | JSON {name, source_addr, body, recipients:[{phone, ...vars}], scheduled_at?}
GET  /api/campaigns ; GET /api/campaigns/:id ; POST /api/campaigns/:id/start|pause|cancel
GET  /api/audit-logs           ?org_id&action&from&to
GET  /api/dashboard            → role-appropriate summary {balance, today:{messages, delivered, failed}, last7d:[...], counts:{resellers?, clients?, routes?, connections_up?}}
```

## 11. Public HTTP API (clients) — prefix `/v1`

Auth: `Authorization: Bearer sk_live_...` OR header `X-API-Key` OR query `api_key` (legacy GET only).
Checks: key valid & not revoked/expired → org effective `can_api` → IP whitelist scope API (client IP from `X-Forwarded-For` first hop if `TRUST_PROXY=1`) → submit via engine.
```
POST /v1/sms/send   {to: string|string[] (≤1000), from, text, client_ref?}  →  200 {messages:[{to, message_id, status, parts, cost_micros} | {to, error_code, message}]}
GET  /v1/sms/send?api_key=&to=&from=&text=&client_ref=          (legacy; same response)
GET  /v1/sms/:message_id        → {message_id, to, from, status, dlr_stat, parts, cost_micros, created_at, submitted_at, done_at, client_ref}
GET  /v1/balance                → {balance_micros, currency}
```
Single-recipient requests that fail entirely return the proper 4xx/422 with the error body.
Rate limit public API per key: 100 req/s (429 RATE_LIMITED).

## 12. Web UI (web)

Role-aware sidebar. Admin: Dashboard, Resellers, Connections, Routes, Templates, Monitor, Messages, Analytics, Tester, Blocklist, Audit log, Settings. Reseller: Dashboard, Clients, Routes (assigned, with my rates), Templates (client overrides), Sender IDs approvals, Messages, Analytics, Tester, Blocklist, Audit log, Settings (branding, 2FA). Client: Dashboard, Send SMS, Campaigns, Messages (DLR report), Analytics, API & SMPP (keys, SMPP accounts, IP whitelist, webhooks + delivery logs, API docs with curl examples), Sender IDs, Settings (2FA, password). Impersonation banner with "Return to my account". Money shown as currency with up to 4 decimals (micros / 1e6).
