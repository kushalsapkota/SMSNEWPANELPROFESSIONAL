# api: NestJS management REST + public HTTP API

NestJS 10, strict TypeScript, Kysely + pg, zod, ioredis. This package serves `/api/*`
(management, CONTRACTS §10) and, after part 2 lands, `/v1/*` (public API, §11).

Part 1: foundation, auth, tenancy, and the management modules. Part 2: the public `/v1` API,
messages & CSV export, analytics, tester, campaigns (+ worker), dashboard, alerts worker and
OpenAPI docs at `/api/docs` (JSON: `/api/docs-json`). Follow the conventions in this file.

## Run

```bash
cp .env.example .env              # fill APP_ENC_KEY, JWT_SECRET, URLs (CONTRACTS §1)
npm ci
npm run build && npm start        # or: npm run start:dev
npm run seed                      # SUPER_ADMIN org + admin user from ADMIN_EMAIL / ADMIN_PASSWORD (idempotent)
```

Tests need the local Postgres and Redis. They use DB `sms_api2` (reset by jest globalSetup via
`db/reset-db.sh`) and Redis DB 5 (flushed). The engine (and the Telegram Bot API / engine metrics
endpoint) is replaced by a local fake HTTP server (`test/fake-engine.ts`). Background workers are
disabled in tests (`*_INTERVAL_MS=0`) and driven with `worker.tick()`. Set `TEST_DB_NAME` /
`TEST_REDIS_DB` to run against another DB / Redis index (parallel agents).

```bash
npm run lint    # tsc --noEmit over src + test
npm test        # jest --runInBand (e2e with supertest against real Postgres + Redis)
```

## Layout

```
src/
  main.ts / bootstrap.ts      HTTP bootstrap (shared by tests: configureApp)
  app.module.ts               global guards/interceptor/filter + FEATURE_MODULES list
  config/                     zod env schema, fail-fast loadConfig(), APP_CONFIG token
  db/types.ts                 hand-written Kysely types: MUST mirror db/migrations exactly
  db/db.service.ts            tenant + privileged pools, tenant(), afterCommit(), savepoint(), runAs()
  common/                     AppError + codes, exception filter, ZodPipe, pagination, decorators,
                              AsyncLocalStorage request context, TenantInterceptor, validation helpers
  tenancy/scope.service.ts    CONTRACTS §10 authorization rules (?org_id resolver, parent checks)
  crypto/                     AES-GCM v1:, argon2id, API keys, webhook secrets, recovery codes
  engine/                     EngineClient: the ONLY way to call the engine (CONTRACTS §5)
  redis/                      RedisService + InvalidationService (cfg:invalidate, after commit)
  audit/                      AuditService.record() (in-tx) / recordAs() (auth flows)
  auth/                       login/lockout/TOTP/refresh rotation/impersonation, JwtAuthGuard, RolesGuard
  orgs/ balance/ connections/ routes/ templates/ sender-ids/ api-keys/ smpp-accounts/
  ip-whitelist/ webhooks/ blocklist/ notifications/ audit-logs/ monitor/ health/
  messaging/                  shared send fan-out (SendService), MSISDN rules, CSV/money/date/cursor helpers,
                              OrgFilter (which tenants a report covers)
  public-api/                 /v1: ApiKeyGuard (key → state → IP → rate limit → scope), send/status/balance
  messages/                   /api/messages: web send, keyset list, detail, streaming CSV export
  analytics/                  /api/analytics summary/timeseries/breakdown/live (+ engine metrics scrape)
  tester/  dashboard/         /api/tester, /api/dashboard
  campaigns/                  CSV/JSON import, state machine, CampaignWorker (FOR UPDATE SKIP LOCKED)
  alerts/                     AlertsWorker (low balance, route down) + AlertSender (SMTP, Telegram)
  docs/                       OpenAPI document + Swagger UI
  seed.ts
test/                         e2e specs, helpers (setup/login/as/createChild), fake engine
```

## Conventions (read before adding a module)

**Request pipeline.** `JwtAuthGuard` (global) checks the Bearer access JWT. It also re-checks the
DB on every request through the privileged pool: the user must still be active, the token must be
newer than the last password change, and the org must be active unless the caller is
impersonating. It then sets `req.auth`. `RolesGuard` applies `@Roles(...)`. `TenantInterceptor`
opens the AsyncLocalStorage context (`auth`, `ip`, `userAgent`). For authenticated requests it runs
the **whole handler inside one tenant transaction**, which first runs
`set_config('app.org_id', …, true), set_config('app.role', …, true)`.

**Database access.**
- Use `this.db.tenant(trx => …)` for every query in a request. Nested calls reuse the request
  transaction. RLS (`sms_api`) applies to all of them.
- `this.db.privileged` (BYPASSRLS) is allowed only in auth flows, seeding, documented
  cross-tenant integrity lookups, and documented background jobs. Every use is commented at its
  call site. Current uses:
  - auth service and guard;
  - `OrgsService.get` reading `app.org_effective_state`, because a client can't see its parent's row under RLS;
  - the balance reconciler;
  - `ApiKeyGuard` (the API key identifies the tenant; also the throttled `last_used_at` write);
  - `CampaignWorker` and `AlertsWorker` (background jobs across all tenants).
- Handlers that must commit part-way, stream a response, or wait on slow I/O use
  `@NoRequestTransaction()`. Each `db.tenant()` call then is its own transaction. Examples: balance
  top-up (commit the ledger row before calling the engine), webhook test, health. Part 2 needs
  this for the CSV export stream and for campaign sends.
- Side effects that must not see uncommitted state go through `db.afterCommit(fn)`. This covers
  engine kicks and Redis publishes. The hooks are dropped on rollback.
- RLS hides a freshly inserted `organizations` row from `INSERT … RETURNING`, so org ids are
  generated in code (`randomUUID()`).
- Postgres errors map automatically: 23505 → 409 CONFLICT, check/trigger/invalid-input → 400
  INVALID_REQUEST, RLS WITH CHECK → 403.
- `int8` is parsed as a JS number (money is micros). Enum arrays (`bind_type[]`) must be
  selected with `::text[]`.

**Authorization (CONTRACTS §10)** lives in `tenancy/scope.service.ts`:
- `scope.resolve(org_id, 'read'|'write')` handles `?org_id=`. Out of scope, including
  nonexistent orgs, is 403.
- `scope.getOrg(id, mode)` handles `/orgs/:id` routes: hidden is 404, visible but not allowed is 403.
- `scope.requireChild(id)` is for parent-only actions (suspend, routes, balance, billing).
- For rows fetched by id through RLS: not found is 404, then
  `scope.assertOrgAccess(row.org_id, mode)` can return 403. A typical case is the admin
  attempting a write on a client.
- The rules: any org acts on itself; the admin writes resellers and only reads their clients;
  a reseller acts on its clients; a client acts only on itself.

**Validation and errors.** Validate with zod via `@Body(new ZodPipe(schema))` or `parseOrThrow`.
Failures return `400 INVALID_REQUEST` with
`details.issues[{path,message,code}]`. Throw only `AppError` (`src/common/errors.ts`). Its
helpers are `AppError.invalid/forbidden/notFound/conflict/internal` or
`new AppError(code, msg, details?, status?)`. Statuses follow engine-core
CONTRACTS-CHANGES #12 (422 for business rejections). Lists use
`paginationSchema` + `page(items,total,q)` and return `{items,total,page,page_size}`. Messages
use cursor pagination (part 2).

**Audit.** Every mutating management action calls `audit.record({action, entityType, entityId,
targetOrgId, before, after})` inside the same transaction. The service fills in:
- `actor_user_id` (the real user);
- `actor_org_id` (the acting org, which RLS requires);
- `impersonator_user_id` (the `imp` claim);
- `ip` and `user_agent`.

Credentials are stripped from `before` and `after`. Action names are dotted, e.g.
`client.suspend`, `route.assign`, `api_key.revoke`.

**Config invalidation.** After writing any table listed in CONTRACTS §6, call
`invalidation.invalidate(table, id)`. It publishes after commit on `CFG_INVALIDATE_CHANNEL`
(default `cfg:invalidate`). Replace-set endpoints publish `id: null`, which means reload the
entity. These are org routes PUT, route connections PUT, and connection rates PUT.

**Engine.** Call the engine only through `EngineClient`. If the engine is unreachable or returns
5xx, `EngineUnavailableError` is thrown (502 INTERNAL). An engine 4xx with a contract
`error_code` is rethrown as `AppError` with the same code and status. That covers the submit
errors part 2 needs. `kickQuietly()` is best effort.

**Public `/v1`.** `PublicApiController` is `@Public()` (JWT guard skipped) with
`@UseGuards(ApiKeyGuard)`. The guard looks the key up by `sha256(key)` (privileged pool) together
with `app.org_effective_state` and `app.ip_allowed(org, ip, 'API')` in one query, then checks:
revoked/expired → 401; `is_active`/`can_send`/`can_api` → 422 ACCOUNT_SUSPENDED / SENDING_DISABLED /
CHANNEL_DISABLED; IP → 403 IP_NOT_ALLOWED; Redis rate limit (`rl:apikey:<key_id>:<sec>`) → 429;
`@RequireScope(...)` → 403. It sets `req.auth` to the key's org, so `TenantInterceptor` gives the
handler a tenant transaction as that org. Keys are not cached (revocation is immediate).

**Sending.** Everything that submits goes through `SendService` (messaging/), which normalises
destinations like the engine, calls `/submit` for one recipient (errors propagate with the
engine's status) and `/submit/batch` (≤1000) for several (one result row per input, in order).

**Reports.** CDR and rollup queries always carry `created_at`/`bucket` bounds (partition
pruning; default 7 days, max 366/400). `OrgFilter` decides the covered tenants: a RESELLER
`org_id` (or a reseller without `org_id`) means its whole tree. Money per role: admin revenue =
`reseller_cost`, cost = `route_cost`; reseller revenue = its clients' `client_cost`, cost =
`reseller_cost`; client: spend = `client_cost` only. CDR DTOs redact costs the role must not see.

**Workers.** `CampaignWorker` / `AlertsWorker` are in-process `setInterval` jobs (intervals in
config, 0 = off) that are safe to run on several api instances: campaign rows are leased with
`FOR UPDATE SKIP LOCKED`; alerts are de-duplicated with Redis `SET NX EX`.

## Endpoint notes beyond CONTRACTS §10

See `CONTRACTS-CHANGES.md` (api section) for the deviations and additions, all backward compatible:
- login `requires_totp` returns 200;
- password change returns new tokens;
- `Idempotency-Key` on top-ups, and 502 with a pending ledger row when the engine is down
  (the reconciler retries every `LEDGER_RECONCILE_INTERVAL_MS`);
- `rotate_secret` on webhooks;
- sender IDs created by the parent are auto-approved;
- `include_children` on sender IDs;
- admin global blocklist;
- other details.

## HTTP upstream connections

Contract: `docs/providers/HTTP-CONNECTIONS-CONTRACT.md`; api details in `CONTRACTS-CHANGES.md`
("http connections (api/web)"). `connections/http-adapters.ts` holds the engine catalogue cache
(`AdapterCatalogue`, 60s) and the pure credential/setting validation (`mergeCredentials`,
`mergeSettings`). Credentials are one `v1:` AES-GCM JSON object in `http_credentials_enc`, never
returned (`credentials_set` lists key names). `ConnectionsService.dto()` is the only response shape.
The public provider DLR callback (`connections/provider-dlr.*`) reads the raw body through a
middleware registered in `configureApp` before the json parser (64KB cap) and forwards it verbatim
to the engine. Tests: `test/http-connections.e2e-spec.ts` against the fake catalogue in
`test/fake-adapters.ts`.

## Security notes

- Connection passwords, webhook secrets and TOTP secrets are stored only as `v1:` AES-GCM
  strings. They are never returned and are stripped from audit rows.
- Refresh tokens are 32 random bytes; only their sha256 is stored. They rotate on every use, and
  reusing any revoked token revokes the whole family.
- Lockout: 5 consecutive failures (password or 2FA — at login, `totp/disable` and the current
  password of `POST /api/auth/password`) lock the account for 15 minutes. Each TOTP step is
  accepted once (`users.totp_last_step`).
- Every authenticated request and every refresh re-checks the session (`auth/session-check.ts`):
  user active, the REAL org active (also while impersonating), the impersonation still allowed, and
  the `PANEL`/`ALL` IP whitelist of the real org. Adding a `PANEL`/`ALL` rule that excludes the
  caller's own current IP is refused.
- Controls a parent sets on a child (reviewed sender IDs, blocklist entries, IP rules, SMPP account
  settings, user activation / password resets) can't be undone by the child; see
  `isParentActor` in `tenancy/scope.service.ts`.
- Webhook URLs are an SSRF surface: `webhooks/egress.ts` rejects non-public targets on save and on
  the address actually connected to, and the test endpoint never returns the target's body. The
  engine applies the same rule to real deliveries. `WEBHOOK_ALLOW_PRIVATE_TARGETS=1` turns it off
  (dev / tests only).
- Sends are idempotent with `Idempotency-Key` (public and web) and always for campaigns: the api
  chooses the message ids (UUIDv7, `message_id` on the engine submit) and reuses them on a retry.
