# Deployment

Three ways to run the gateway in production, from easiest to most manual:

1. **`setup.sh`**: one command on a fresh Linux server (recommended).
2. **Docker Compose by hand**: the same stack, step by step.
3. **Native** (no Docker): see [DEVELOPMENT.md](DEVELOPMENT.md); meant for development.

Requirements: a 64-bit Linux server with at least 2 CPU / 4 GB RAM / 20 GB disk, root access, and
ports 80, 443 and 2775 reachable. For HTTPS, a DNS A record pointing at the server.

## 1. One-command install (`setup.sh`)

```bash
git clone <this repo> sms-gateway && cd sms-gateway
sudo ./setup.sh --domain panel.example.com --email you@example.com
```

Without `--domain` the panel is served over plain HTTP on the server IP.

What it does (safe to re-run; existing `.env`, certificates and data are kept):

1. Installs Docker + Compose, nginx, certbot and python3 (apt; dnf/yum best effort).
2. Copies the project to `/opt/sms-gateway` and writes `deploy/.env` with freshly generated
   secrets. Postgres memory is sized to the machine's RAM.
3. Installs the host **domain-agent** (systemd), then builds and starts the stack with the
   **firewall-agent**, and waits for engine, api and web to report healthy.
4. Seeds the SUPER_ADMIN. With no `--admin-password`, a random one is saved to
   `/root/SMS-PANEL-CREDENTIALS.txt` (mode 600).
5. Configures nginx. With a domain it obtains a Let's Encrypt certificate (webroot), installs the
   TLS vhost from `deploy/nginx-duckdns.conf` and adds a renewal hook that reloads nginx.
6. Opens 22/80/443/2775 in ufw or firewalld if one is active.

| Option | Meaning |
|---|---|
| `--domain D` | Panel / API / SMPP hostname. Omit for IP-only HTTP. |
| `--email E` | Let's Encrypt account email (default: admin email). |
| `--admin-email E` / `--admin-password P` | SUPER_ADMIN login. |
| `--dir PATH` | Install location (default `/opt/sms-gateway`). |
| `--env FILE` | Reuse an existing `deploy/.env` (required when migrating: `APP_ENC_KEY` must match). |
| `--restore DUMP` | Restore a `pg_dump -Fc` dump (`.dump` or `.dump.gz`) into the new stack. |
| `--no-nginx` | Skip nginx / certbot (bring your own proxy). |
| `--no-firewall` | Don't start the firewall-agent. |
| `--no-domain-agent` | Don't install the domain-agent. |
| `--sim` | Also start the fake upstream SMSC (testing only). |

### Moving to a new server

```bash
# old server: dump WITH privileges (the RLS grants must come along)
docker exec smsgw-postgres-1 pg_dump -Fc -U sms_owner sms_gateway | gzip > smsgw.dump.gz
# copy smsgw.dump.gz and deploy/.env to the new server, then:
sudo ./setup.sh --domain panel.example.com --env ./old.env --restore ./smsgw.dump.gz
```

Without the old `APP_ENC_KEY`, stored upstream passwords, webhook secrets and 2FA secrets cannot be
decrypted. Live balances are re-hydrated from Postgres on first use.

## 2. Docker Compose by hand

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


## Host agents (optional admin features)

Two privileged helpers back SUPER_ADMIN pages in the panel. Both are off unless their token is set,
and both talk to the api over a unix socket authenticated by a shared token.

| Agent | Panel page | Runs as | What it may change |
|---|---|---|---|
| `firewall-agent` | Firewall | Compose service (profile `firewall`, host network, `NET_ADMIN`) | Only the `inet smsgw` nftables table. SSH, 80/443 and `FW_PROTECTED_PORTS` can never be blocked; every apply auto-reverts after `FW_REVERT_SECONDS` unless confirmed. |
| `domain-agent` | Domains | systemd on the host (`deploy/domain-agent/`) | Only `/etc/nginx/sites-available/smsgw-managed-<domain>` vhosts and their Let's Encrypt certs. Runs `nginx -t` before every reload and rolls back on failure. |

```bash
# firewall-agent: set FW_AGENT_TOKEN in deploy/.env, then
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env --profile firewall up -d firewall-agent
# domain-agent: the token must equal DOMAIN_AGENT_TOKEN in deploy/.env
DOMAIN_AGENT_TOKEN=... sudo -E deploy/domain-agent/install.sh
```

## nginx configs

| File | Use |
|---|---|
| `deploy/nginx-duckdns.conf` | Single domain: panel + API on 443, ACME on 80. Used by `setup.sh`. |
| `deploy/nginx-http-ip.conf` | No domain yet: plain HTTP on the server IP. |
| `deploy/nginx.conf` | Full example: separate panel / API hostnames and an SMPP `stream` block (2775 plain, 3775 TLS). |

SMPP is raw TCP published directly by the engine container, so nginx is not in the SMPP path
unless you use the `stream` block.

## Observability (optional)

```bash
cd deploy
docker compose -f docker-compose.prod.yml -f docker-compose.observability.yml --env-file .env up -d
```

Prometheus, Alertmanager and Grafana (on `127.0.0.1:3002`; set `GRAFANA_ADMIN_PASSWORD`).

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

