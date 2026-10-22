# Contributing

## Layout

- `engine/` — Go: SMPP server/client, routing, billing, DLR, CDR, webhooks, metrics
- `api/` — NestJS: `/api/*` management and `/v1/*` public API, plus background workers
- `web/` — Next.js operator panel
- `db/` — Postgres schema, migrations, RLS, schema tests
- `redis/` — balance Lua scripts and their tests
- `deploy/` — Dockerfiles, compose, nginx, backup, observability, CI helpers

Cross-component contract: `CONTRACTS.md` with additions in `CONTRACTS-CHANGES.md`. Keep them current.

## Local development

```bash
make dev-up      # fresh DB, build, start smsc-sim + engine + api + web
make dev-demo    # provision demo tenants, run an HTTP + SMPP round trip
make dev-down    # stop everything
```

## Tests

Run the whole suite before opening a pull request:

```bash
make test        # deploy checks, DB schema, migrations, Lua, Go -race, api, web
```

Individual suites: `make test-db test-migrate test-lua test-go test-api test-web test-deploy`.
CI (`.github/workflows/ci.yml`) runs the same targets, and `security.yml` runs dependency and
filesystem scans. Both must be green to merge.

## Conventions

- Money is integer micros everywhere (1 unit = 1,000,000). No floats.
- Any new environment variable used by `deploy/docker-compose.prod.yml` must be documented in
  `deploy/.env.example` (the deploy validator enforces this).
- New management endpoints enforce authorization in the service layer (scope/parent checks), not
  only in route decorators; RLS is isolation, not authorization.
- Secrets never go in audit rows — extend `sanitizeForAudit` if you add a sensitive field.
- OTP and provider regexes must be RE2-compatible (the Go engine evaluates them).

## Commits

Small, focused commits with a clear subject line. Update `CONTRACTS-CHANGES.md` when behavior that
another component relies on changes.
