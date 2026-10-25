# Architecture

Components: **engine** (Go: SMPP server/client, routing, billing, DLR, CDR), **api** (NestJS:
management REST `/api/*` and the public HTTP API `/v1/*`), **web** (Next.js panel), backed by
**PostgreSQL 16** and **Redis 7**. Roles: SUPER_ADMIN manages resellers, a RESELLER controls its
clients (suspend, channels, routes, rates, credit), and CLIENTs send over HTTP, SMPP or the panel.
The cross-component contract is [CONTRACTS.md](../CONTRACTS.md), with additions in
[CONTRACTS-CHANGES.md](../CONTRACTS-CHANGES.md).

## Component diagram

```
                 HTTPS (nginx: deploy/nginx.conf)                   raw TCP / TLS
   browsers ───────────────┐            HTTP API clients ──┐      SMPP clients (ESMEs)
                           v                               v              │
                 ┌──────────────────┐  /api,/v1   ┌──────────────────┐    │ :2775 bind/submit_sm
                 │ web  Next.js     │────────────>│ api   NestJS     │    │ deliver_sm (DLR)
                 │ :3001  panel UI  │  rewrites   │ :3000 /api /v1   │    v
                 └──────────────────┘             │ workers:         │  ┌───────────────────────────┐
                                                  │ campaigns,alerts,│  │ engine  Go                │
                                                  │ ledger reconcile │─>│ :8081 internal HTTP (token)│
                                                  └────────┬─────────┘  │ :2775 client SMPP server  │
                                     RLS role (sms_api) +  │            │ :9100 /metrics /healthz   │
                                     privileged (sms_engine)            │ pipeline: policy → route →│
                                                           │ cfg:invalidate  template → limits → debit │
                                                           v  (pub/sub) │ dispatch · DLR · webhooks │
            ┌─────────────────────────────┐   ┌──────────────────────┐  │ CDR writer · bal syncer   │
            │ PostgreSQL 16               │<──│ Redis 7 (AOF)        │<─└─────────────┬─────────────┘
            │ tenants, routes, rates,     │   │ balances (Lua), rate │   SQL (BYPASSRLS)│ SMPP client
            │ message_logs (monthly parts)│   │ limits, msg state,   │                  │ sessions, TPS
            │ stats_hourly, audit, RLS    │   │ dispatch streams     │                  v
            └─────────────────────────────┘   └──────────────────────┘     upstream SMSCs / smsc-sim :2776
```

## Ports

| Port | Service | Exposure |
|---|---|---|
| 3001 | web panel (also proxies `/api/*`, `/v1/*`) | published |
| 3000 | api: `/api/*` management, `/v1/*` public, `/api/docs` Swagger, `/api/health` | published |
| 2775 | engine client SMPP server | published |
| 8081 | engine internal HTTP (`X-Internal-Token`) | internal only (api) |
| 9100 | engine Prometheus `/metrics`, liveness `/healthz` | internal only (scrape from the `backend` network) |
| 5432 / 6379 | Postgres / Redis (compose) | `data` network only (local dev Redis: 6399) |
| 2776 / 2777 | smsc-sim SMPP / HTTP inspector | dev / `sim` profile only |


## Data layer

```
db/migrations/001_init.sql               tenancy, auth, balances, routes, templates, credentials, audit
db/migrations/002_message_logs.sql       monthly-partitioned CDRs, partition mgmt, hourly rollups
db/migrations/003_rls.sql                row-level tenant isolation + DB roles
db/migrations/004_features.sql           campaigns, webhooks, sender IDs, blocklists, API keys, ...
db/migrations/005_otp_patterns.sql       OTP extraction patterns
db/migrations/006_*.sql                  API security fixes, RLS hardening
db/migrations/007_http_connections.sql   HTTP upstream connections (provider adapters)
db/migrations/008_smpp_password_reveal.sql
db/migrations/009_service_switches.sql   kill switches
db/migrations/010_content_approval.sql   content approval
db/tests/schema_test.sql                 schema assertions (hierarchy, cascades, RLS, partitions, ...)
redis/lua/{load,debit,refund,credit}.lua atomic balance engine
redis/tests/lua_test.sh                  Lua tests incl. a 1000-way concurrent debit race
```

**Money is integer micros everywhere** (1 unit = 1,000,000). Postgres `bigint`, Redis `HINCRBY`, no floats.

**Dual-debit billing.** Each send debits the client at its rate *and* the reseller at the
admin's rate, atomically in one script. If either is short, neither is charged. The reseller's
margin is the difference. When a reseller tops up a client, that only records the payment; no
reseller credit moves.

**Redis key layout.** Every key for one tenant tree shares the `{t:<reseller_id>}` hash tag, so a
client's and its reseller's balances sit in the same Redis Cluster slot (required for a multi-key Lua script):

```
{t:<reseller_id>}:bal:<org_id>       HASH  bal, limit
{t:<reseller_id>}:txn:<message_id>   HASH  debit record (enables idempotency + capped refunds), TTL
{t:<reseller_id>}:credit:<idem_key>  STR   top-up idempotency marker
```

**Balance lifecycle.**
1. Hydrate: `load.lua` from `accounts_balance` (never overwrites a live key).
2. Send: `debit.lua`. A retried submit with the same message id returns `DUPLICATE` and charges nothing.
3. Failure / partial multipart: `refund.lua` (capped at the debited amount, can't double-refund).
4. Top-up: insert a `balance_transactions` row, then `credit.lua` with its `idempotency_key`, then set `applied_at`.
5. A syncer copies Redis → `accounts_balance` periodically (Phase 2).

**Hierarchy is enforced by the DB**, not just the API. A CLIENT must have a RESELLER parent and
a RESELLER must have a SUPER_ADMIN parent. Roles are immutable. A reseller can only assign routes
the admin gave it. Unassigning a route from a reseller disables it for all of its clients.
`app.org_effective_state` folds the reseller's state into the client's: suspending a reseller
blocks all of its clients.

**RLS.** The API connects as `sms_api` and sets `app.org_id` / `app.role` per transaction.
Clients see themselves, resellers see themselves plus their clients, admin sees everything, and no
context means nothing is visible. Upstream credentials are admin-only. The Go engine uses
`sms_engine` (BYPASSRLS). RLS handles isolation only; authorization (e.g. a client can't edit its
own balance) is the API's job.

**OTP regexes must be RE2-compatible** (the Go engine evaluates them; no look-arounds).
The spec's fallback `\b[A-Za-z0-9]{5,8}\b` matches ordinary words ("Hello" → *"Your code is
Hello"*), so the default requires at least one letter **and** one digit, with length enforced via
`otp_min_len`/`otp_max_len`.

**Partitions.** Run `SELECT app.ensure_message_log_partitions();` daily (pg_cron or a cron job);
it keeps 3 months ahead. Alert if `message_logs_default` has any rows. Retention:
`SELECT app.drop_message_log_partitions('13 months');`.

