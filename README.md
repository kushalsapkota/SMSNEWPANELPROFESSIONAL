# SMS Gateway: Phase 1 (data layer)

```
db/migrations/001_init.sql          tenancy, auth, balances, routes, templates, credentials, audit
db/migrations/002_message_logs.sql  monthly-partitioned CDRs, partition mgmt, hourly rollups
db/migrations/003_rls.sql           row-level tenant isolation + DB roles
db/tests/schema_test.sql            55 assertions (hierarchy, cascades, RLS, partitions, ...)
redis/lua/{load,debit,refund,credit}.lua   atomic balance engine
redis/tests/lua_test.sh             35 assertions incl. 1000-way concurrent debit race
```

## Run tests

```bash
createdb sms_test && for f in db/migrations/*.sql; do psql -v ON_ERROR_STOP=1 -d sms_test < $f; done
psql -v ON_ERROR_STOP=1 -d sms_test < db/tests/schema_test.sql   # -> ALL SCHEMA TESTS PASSED
REDIS_PORT=6379 redis/tests/lua_test.sh                          # -> ALL LUA TESTS PASSED (flushes db 15)
```

## Key design decisions

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

## Known follow-ups for Phase 2
- Redis → Postgres balance syncer, and reconciliation of `NOT_LOADED` refunds via the ledger.
- `org_effective_state` under `sms_api`: a client can't see its reseller's row, so the
  inherited flags show as permissive there. The engine (BYPASSRLS) gets the true value, which is what
  enforces sending. Use the engine's value, or a definer function, for any UI display.

---

# Running the platform

Components: **engine** (Go: SMPP server/client, routing, billing, DLR, CDR), **api** (NestJS:
management REST `/api/*` and the public HTTP API `/v1/*`), **web** (Next.js panel), backed by
**PostgreSQL 16** and **Redis 7**. Roles: SUPER_ADMIN manages resellers, a RESELLER controls its
clients (suspend, channels, routes, rates, credit), and CLIENTs send over HTTP, SMPP or the panel.
The cross-component contract is [CONTRACTS.md](CONTRACTS.md), with additions in
[CONTRACTS-CHANGES.md](CONTRACTS-CHANGES.md).

## Quick start: native, no Docker

Needs root, Go 1.23, Node 22, PostgreSQL 16 on :5432, Redis on :6399, plus `curl`, `jq`, `openssl`
and `make`.

```bash
make dev-up        # or deploy/dev-up.sh
make dev-down      # stop everything (make dev-purge also drops sms_dev + Redis DB 6)
```

`dev-up` does the following:
1. Recreates database `sms_dev` (`db/reset-db.sh`, dev login roles) and flushes Redis DB 6.
2. Builds the engine, `smsc-sim` and `smpp-cli` into `deploy/.run/bin`, the api (`dist/`), and the
   web (`next build`).
3. Starts smsc-sim, then the engine, seeds the admin, then starts the api and the web. Each runs in
   its own process group, with its PID in `deploy/.run/*.pid` and its log in `deploy/.run/logs/*.log`.
4. Waits for every health check. If any fails, it stops everything it started and prints the log.
5. Provisions a demo tree through the REST API (`deploy/dev-demo.sh`):
   - a connection to smsc-sim and a route;
   - a reseller and a client with credit and SMPP enabled;
   - an API key and the SMPP account `demo1`/`demopw1`.

   It then sends one SMS over **HTTP** and one over **SMPP** and waits for both DLRs (`DELIVERED`).

Logins: `admin@smsgw.local` / `Admin-Passw0rd!`, `reseller@smsgw.local` / `Reseller-Passw0rd!`,
`client@smsgw.local` / `Client-Passw0rd!`. The client API key is in `deploy/.run/demo.env`.
Settings: `WEB_MODE=dev` (hot reload), `DEV_RESET_DB=0` (keep data), `DEV_DEMO=0`, `DEV_DB`,
`DEV_REDIS_DB`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`. Run `deploy/dev-demo.sh` any time as an end-to-end
smoke test.

To run beside another stack on the same machine (for example the integration e2e run), shift every
port: `DEV_PORT_OFFSET=10000 make dev-up` gives api 13000, web 13001, SMPP 12775, engine 18081 /
19100 and smsc-sim 12776 / 12777. Single ports can be set with `DEV_API_PORT`, `DEV_WEB_PORT`,
`DEV_ENGINE_HTTP_PORT`, `DEV_SMPP_PORT`, `DEV_METRICS_PORT`, `DEV_SIM_PORT`, `DEV_SIM_HTTP_PORT`.
The ports in use are saved to `deploy/.run/ports.env`, which `dev-demo.sh` reads. A different api
port means a web rebuild, because `API_URL` is baked into `web/.next`. Use a different `DEV_DB` and
`DEV_REDIS_DB` too. The engine's `cfg:invalidate` channel is shared by every Redis DB, so two
stacks on one Redis trigger each other's config reloads. That is harmless: each engine reloads
from its own database.

```bash
source deploy/.run/demo.env
curl -s localhost:3000/v1/sms/send -H "Authorization: Bearer $DEMO_API_KEY" \
     -H 'Content-Type: application/json' -d '{"to":"+447700900123","from":"DEMO","text":"Code 1234"}'
deploy/.run/bin/smpp-cli -system-id demo1 -password demopw1 -from DEMO -to 447700900123 -text "hi"
curl -s localhost:2777/messages | jq '.[0]'          # what the fake SMSC received
```

## Quick start: Docker (production layout)

```bash
cp deploy/.env.example deploy/.env && chmod 600 deploy/.env
# fill the secrets: the one-liner at the top of .env.example generates all of them
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d --build
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='<strong password>' \
  docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env --profile seed run --rm seed
# optional fake upstream for staging: --profile sim up -d smsc-sim  (connection host smsc-sim:2776)
```

The stack is defined in `deploy/docker-compose.prod.yml`:

| Service | What it does |
|---|---|
| `postgres` | 16, scram-sha-256 |
| `redis` | 7: AOF everysec, `noeviction`, password |
| `db-init` | One-shot. Runs `deploy/migrate.sh`, which applies the migrations in order and records them in `schema_migrations`. Then runs `deploy/init/init-roles.sh`, which creates the login roles from env: the api role (RLS) and the engine role (BYPASSRLS). Then creates partitions. Runs again on every `up`, and does nothing if there is no work. |
| `db-maint` | Partition upkeep every 6h. |
| `engine` / `api` / `web` | Healthchecks, `restart: unless-stopped`, log rotation, graceful stop periods. |
| `seed` | Profile `seed`. Idempotent admin seed. |
| `smsc-sim` | Profile `sim`. |

Postgres and Redis sit only on the internal `data` network. The engine's internal API (8081) and
metrics (9100) sit only on the internal `backend` network. The only published ports are web 3001,
api 3000 (bound to `PUBLISH_ADDR`, default `127.0.0.1` so only nginx reaches them) and SMPP 2775
(bound to `SMPP_PUBLISH_ADDR`, default `0.0.0.0`). Images: `deploy/engine.Dockerfile` (static Go,
non-root uid 10001), `deploy/api.Dockerfile` (production node_modules only, user `node`),
`deploy/web.Dockerfile` (Next.js standalone; `API_URL` and `NEXT_PUBLIC_*` are build args). Run
`make docker-build` to build all three.

**TLS:** `deploy/nginx.conf` terminates HTTPS for the panel and the API. SMPP is raw TCP, so it goes
in a `stream` block: plain 2775 and SMPP-over-TLS on 3775. Keep `PUBLISH_ADDR=127.0.0.1` and
`TRUST_PROXY=1` behind it. The api believes `X-Forwarded-For` only from `TRUSTED_PROXIES` peers
(default loopback + private ranges) and takes the right-most hop that is not a trusted proxy, so a
client cannot prepend a whitelisted address. If web/api are exposed directly instead, set
`TRUST_PROXY=0`: the web forwards a client's own `X-Forwarded-For` to the api. nginx's access log
redacts the query string of any request carrying `api_key`.

## Architecture

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

## Environment

`deploy/.env.example` documents every variable the compose stack uses, with generate commands.

| Required | Meaning |
|---|---|
| `POSTGRES_PASSWORD` | Owner password, used only by db-init and db-maint. |
| `SMS_API_DB_PASSWORD` | Login role for the api tenant pool (RLS). |
| `SMS_ENGINE_DB_PASSWORD` | Login role for the engine and the api privileged pool (BYPASSRLS). |
| `REDIS_PASSWORD` | Redis password. |
| `INTERNAL_TOKEN` | Shared secret for api → engine calls. |
| `APP_ENC_KEY` | AES-256-GCM key for the `*_enc` columns. **Back it up. Never rotate it in place.** |
| `JWT_SECRET` | Signs panel JWTs. |

Passwords that appear in URLs must be URL-safe, so use `openssl rand -hex 24`. The engine reads
`DATABASE_URL`, `REDIS_URL`, `INTERNAL_TOKEN`, `APP_ENC_KEY` and `ENGINE_*` tunables
(`engine/internal/config`). The api reads the same names plus `DATABASE_URL_PRIVILEGED`,
`ENGINE_URL`, `JWT_SECRET`, SMTP / Telegram settings and worker intervals (`api/.env.example`). The
web reads `API_URL` at **build** time (CONTRACTS-CHANGES web part 1 #2).

## Make targets

```
make dev-up | dev-down | dev-purge | dev-demo   native stack
make build                                        engine/bin/*, api/dist, web/.next
make test                                         deploy checks, schema, migrate.sh, Lua, go vet + go test -race,
                                                  api lint + jest, web lint + typecheck + vitest + build
make test-go GO_TEST_DB_CORE=x GO_TEST_DB_FLOW=y  any suite alone; fixture DB names / Redis DBs are overridable
make docker-build | compose-up | compose-down
make migrate | partitions                         operations against $DATABASE_URL / PG* (schema owner)
```

## Operations

**Migrations.** `deploy/migrate.sh` applies `db/migrations/*.sql` in order. Each file and its
`schema_migrations` row commit in the same transaction, and a session advisory lock serializes
concurrent runners. It refuses to run if an applied file's checksum has changed: migrations are
append-only, so add `006_*.sql` instead of editing an old file. For a database built with
`db/reset-db.sh` (no tracking rows), run once with `MIGRATE_BASELINE=1`. A file marked
`-- migrate:no-transaction` runs outside a transaction, for `CREATE INDEX CONCURRENTLY`. The usual
upgrade is:

```bash
docker compose ... build && docker compose ... up -d
```

db-init applies new files before the engine and api start.

**Partitions.** `message_logs` is partitioned by month. `deploy/init/maintenance.sh` creates
partitions from last month through `MAINT_PARTITION_MONTHS` (default 3) ahead. If
`MESSAGE_LOG_RETENTION` (e.g. `13 months`) is set, it drops whole partitions older than that. It
warns when rows land in `message_logs_default`; treat that as an alert. In compose, `db-maint` runs
it every 6h. Without compose, add a cron line:

```cron
15 3 * * *  PGHOST=db PGUSER=sms_owner PGPASSWORD=... PGDATABASE=sms_gateway /opt/smsgw/deploy/init/maintenance.sh >>/var/log/smsgw-maint.log 2>&1
```

**Backups.**
- *Postgres:* take a nightly logical dump:

  ```bash
  docker compose ... exec -T postgres pg_dump -U sms_owner -Fc sms_gateway > sms_$(date +%F).dump
  ```

  Restore with `pg_restore -d <empty db> --no-owner`, then run db-init, which recreates the login
  roles. Roles are cluster-wide and are not in the dump. For point-in-time recovery, run WAL
  archiving (pgBackRest or wal-g) against the `pg_data` volume.
- *Redis* holds the live balances. The engine's syncer copies them to `accounts_balance` every
  ~2s, and Postgres is the system of record when a key is missing, because the engine re-hydrates.
  Still snapshot the AOF/RDB in `redis_data` (`BGSAVE`, then copy `/data`) so that in-flight
  debits, queued dispatch streams and DLR maps survive a host loss.
- *Secrets:* keep `APP_ENC_KEY` in a secret manager. A database backup is unreadable for the
  `*_enc` columns without it.

**Monitoring.**
- Scrape `engine:9100/metrics` from the `backend` network.
- Readiness checks: `GET /internal/v1/health` (with the token; 503 when DB or Redis is down) and
  `GET /api/health`.
- Alert on Redis `used_memory` against `maxmemory`: with `noeviction`, writes fail when it is full.
- Alert on rows in `message_logs_default`.
- Alert on engine `connections_up < connections_total` (also visible in `/api/analytics/live`).

**Scaling.**
- *api:* stateless, so scale it horizontally (`docker compose up -d --scale api=3`, but then drop
  the fixed host port and put nginx or a load balancer in front). The background workers can stay
  on in every replica: campaigns are claimed with `FOR UPDATE SKIP LOCKED`, alerts are deduplicated
  in Redis, and the ledger reconciler is idempotent.
- *engine:* several instances can share Postgres and Redis. Each takes a unique
  `ENGINE_INSTANCE_ID` (defaults to hostname-pid) as its Redis stream consumer. Balance syncs are
  guarded by `synced_at`, and dispatch uses consumer groups. Note:
  - Every instance binds every upstream connection's `sessions`, so divide those counts and TPS
    across instances or the upstream sees N× the binds.
  - Client SMPP sessions are per instance. Front them with a TCP load balancer. A client's binds
    may land on different instances: multipart parts are reassembled in Redis (`cc:*`), and
    delivery receipts are handed to the instance that holds the client's RX/TRX session (receiver
    registry `smpp:rx:<system_id>`, per-instance stream `q:dlr-out:i:<instance>`; the stream of an
    instance that stops heart-beating is moved back to `q:dlr-out` after ~2 minutes).
- *Redis:* must stay a single primary, not Redis Cluster, because the rate-limit script uses keys
  without a shared hash tag. Scale it vertically, and use Sentinel or a managed replica for
  failover.
- *Postgres:* size `PG_MAX_CONNECTIONS` for engine pools + 2 × api pools per replica. Monthly
  partitions keep `message_logs` indexes small. Put a read replica behind reporting if analytics
  load grows.
