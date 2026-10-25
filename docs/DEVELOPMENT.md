# Development

See also [CONTRIBUTING.md](../CONTRIBUTING.md).

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


## Data-layer tests on a bare database

```bash
createdb sms_test && for f in db/migrations/*.sql; do psql -v ON_ERROR_STOP=1 -d sms_test < $f; done
psql -v ON_ERROR_STOP=1 -d sms_test < db/tests/schema_test.sql   # -> ALL SCHEMA TESTS PASSED
REDIS_PORT=6379 redis/tests/lua_test.sh                          # -> ALL LUA TESTS PASSED (flushes db 15)
```

