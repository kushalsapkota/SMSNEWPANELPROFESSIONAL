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
