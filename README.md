# SMS Gateway

A multi-tenant A2P SMS platform: an SMPP/HTTP gateway with routing, real-time prepaid/postpaid
billing, delivery reports and a web panel for a three-level hierarchy of **admin → resellers →
clients**.

- **engine** (Go): client SMPP server, upstream SMPP and HTTP connections, routing, billing, DLRs,
  CDRs, webhooks and Prometheus metrics
- **api** (NestJS): management REST `/api/*`, public HTTP API `/v1/*`, background workers
- **web** (Next.js): operator, reseller and client panel
- **PostgreSQL 16** (row-level security, monthly-partitioned message logs) and **Redis 7**
  (atomic balance scripts, rate limits, queues)

## Features

**Sending**
- Client SMPP 3.4 server (TX/RX/TRX, multipart, delivery receipts) and HTTP API with idempotency keys
- Upstream connections over SMPP or HTTP provider adapters (Nepal providers built in), with live
  carrier status
- Prefix routing with priorities and failover, sender ID management, message templates, OTP
  extraction, blocked numbers and keywords, content approval
- Campaigns (bulk sends) and signed delivery-report webhooks

**Billing**
- Money as integer micros end to end; prepaid or postpaid with credit limits
- Atomic dual debit: each message charges the client *and* its reseller, so reseller margins are
  exact; automatic refunds for failed sends; full ledger and reconciliation

**Panel**

| Role | Can do |
|---|---|
| Super admin | Resellers and bulk client creation, upstream connections, routes and rates, kill switches, live SMPP monitor, host firewall, domains / TLS certificates, audit log |
| Reseller | Clients (suspend, channels, routes, rates, credit), routes and templates, billing, tester, blocklists, monitor, audit log |
| Client | Send and campaigns, messages and analytics, sender IDs, API keys and SMPP credentials (Developer page) |

**Security**: RLS tenant isolation enforced in the database, TOTP 2FA, per-account IP whitelists for
panel / API / SMPP, encrypted credentials (AES-256-GCM), login rate limiting, audit trail.

## Quick install

On a fresh Ubuntu/Debian server, with a DNS record pointing at it:

```bash
git clone https://github.com/kushalsapkota/SMSNEWPANELPROFESSIONAL.git sms-gateway && cd sms-gateway
sudo ./setup.sh --domain panel.example.com --email you@example.com
```

This installs Docker, nginx and certbot, generates all secrets, builds and starts the stack, issues
a TLS certificate and creates the admin account (credentials go to
`/root/SMS-PANEL-CREDENTIALS.txt`). Then open `https://panel.example.com`.

Clients connect to:

| | |
|---|---|
| Panel | `https://panel.example.com` |
| HTTP API | `https://panel.example.com/v1/sms/send` |
| SMPP | `panel.example.com:2775` |

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for all options, manual Docker setup, moving to a new
server and TLS details.

## Documentation

| Document | Contents |
|---|---|
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | `setup.sh`, Docker Compose, nginx / TLS, host agents, environment variables |
| [docs/API.md](docs/API.md) | Client HTTP API and SMPP connection details |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Upgrades and migrations, partitions, backups, monitoring, scaling |
| [deploy/BACKUP.md](deploy/BACKUP.md) | Backup and restore procedures |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, ports, data model, billing and RLS design |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Running locally without Docker, make targets, tests |
| [docs/providers/](docs/providers/) | Upstream HTTP provider research and adapter contract |
| [CONTRACTS.md](CONTRACTS.md) / [CONTRACTS-CHANGES.md](CONTRACTS-CHANGES.md) | Cross-component contract (internal API, Redis keys, encryption, public API) |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Layout, workflow and tests for contributors |

## Repository layout

```
engine/     Go engine (cmd/engine, cmd/smsc-sim, cmd/smpp-cli, internal/*)
api/        NestJS API
web/        Next.js panel
db/         migrations, schema tests, dev reset script
redis/      balance Lua scripts and tests
deploy/     Dockerfiles, compose, nginx, backups, observability, host agents, e2e
docs/       documentation
setup.sh    one-command server installer
```

## Day-to-day commands

```bash
cd /opt/sms-gateway
C="docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env"
$C ps                         # status
$C logs -f --tail 100 engine  # logs
git pull && $C build && $C up -d   # upgrade (migrations run automatically)
deploy/backup.sh              # database backup
```

## Security notes

- Never commit `deploy/.env`. Back up `APP_ENC_KEY` separately: without it, stored upstream
  passwords, webhook secrets and 2FA secrets cannot be decrypted.
- Keep `PUBLISH_ADDR=127.0.0.1` so web and api are only reachable through nginx.
- Swagger (`/api/docs`) is disabled by default and always blocked at the nginx edge.
