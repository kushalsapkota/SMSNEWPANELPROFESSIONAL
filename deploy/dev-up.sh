#!/usr/bin/env bash
# deploy/dev-up.sh: run the WHOLE stack natively on this machine, without Docker.
#
#   deploy/dev-up.sh            # fresh sms_dev DB, build, start smsc-sim, engine, api, web
#   deploy/dev-down.sh          # stop everything this script started
#
# What it does:
#   1. fresh database $DEV_DB (default sms_dev) via db/reset-db.sh, which also creates the dev login
#      roles, then records the migrations in schema_migrations (deploy/migrate.sh baseline).
#      It also flushes Redis DB $DEV_REDIS_DB (default 6) on port $REDIS_PORT (default 6399).
#   2. builds engine, smsc-sim and smpp-cli into deploy/.run/bin, the api (dist/) and the web
#      (next build, or `next dev` with WEB_MODE=dev)
#   3. starts smsc-sim (:2776, HTTP :2777), the engine (:2775 SMPP, :8081 internal, :9100 metrics),
#      seeds the admin, then starts the api (:3000) and the web (:3001). Each process is in its own
#      process group, with its PID in deploy/.run/<name>.pid and its log in deploy/.run/logs/<name>.log
#   4. waits for every health endpoint; on any failure, it stops what it started and prints the log
#   5. DEV_DEMO=1 (default): runs deploy/dev-demo.sh, which provisions a sim connection, a route,
#      a reseller and a client with credit, then sends one SMS over HTTP and waits for its DLR
#
# Env knobs:
#   DEV_DB=sms_dev  DEV_REDIS_DB=6  REDIS_PORT=6399  PGPORT=5432
#   DEV_PORT_OFFSET=0   added to every default port below (to run beside another stack)
#   DEV_API_PORT=3000 DEV_WEB_PORT=3001 DEV_ENGINE_HTTP_PORT=8081 DEV_SMPP_PORT=2775
#   DEV_METRICS_PORT=9100 DEV_SIM_PORT=2776 DEV_SIM_HTTP_PORT=2777   (saved to .run/ports.env)
#   DEV_RESET_DB=1      0 = keep the existing DB and Redis data (skips reset, flush and demo)
#   WEB_MODE=prod       prod = next build + next start; dev = next dev (hot reload)
#   DEV_DEMO=1          0 = skip demo provisioning / SMS round trip
#   ADMIN_EMAIL=admin@smsgw.local  ADMIN_PASSWORD=Admin-Passw0rd!
# Needs root (db/reset-db.sh runs psql as the postgres OS user), Go 1.23, Node 22, redis-cli, curl, jq.
set -Eeuo pipefail

DEPLOY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DEPLOY/.." && pwd)"
RUN="$DEPLOY/.run"
LOGS="$RUN/logs"
BIN="$RUN/bin"

DEV_DB="${DEV_DB:-sms_dev}"
DEV_REDIS_DB="${DEV_REDIS_DB:-6}"
REDIS_PORT="${REDIS_PORT:-6399}"
PGPORT="${PGPORT:-5432}"
DEV_RESET_DB="${DEV_RESET_DB:-1}"
WEB_MODE="${WEB_MODE:-prod}"
DEV_DEMO="${DEV_DEMO:-1}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@smsgw.local}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-Admin-Passw0rd!}"

# Ports (CONTRACTS §1 defaults). Override them to run next to another stack on this machine,
# e.g. DEV_PORT_OFFSET=10000 → api 13000, web 13001, SMPP 12775, ... (individual DEV_*_PORT win).
DEV_PORT_OFFSET="${DEV_PORT_OFFSET:-0}"
[[ "$DEV_PORT_OFFSET" =~ ^[0-9]{1,5}$ ]] || { echo "[dev-up] ERROR: DEV_PORT_OFFSET must be a number" >&2; exit 1; }
API_PORT="${DEV_API_PORT:-$((3000 + DEV_PORT_OFFSET))}"
WEB_PORT="${DEV_WEB_PORT:-$((3001 + DEV_PORT_OFFSET))}"
ENGINE_HTTP_PORT="${DEV_ENGINE_HTTP_PORT:-$((8081 + DEV_PORT_OFFSET))}"
SMPP_PORT="${DEV_SMPP_PORT:-$((2775 + DEV_PORT_OFFSET))}"
METRICS_PORT="${DEV_METRICS_PORT:-$((9100 + DEV_PORT_OFFSET))}"
SIM_PORT="${DEV_SIM_PORT:-$((2776 + DEV_PORT_OFFSET))}"
SIM_HTTP_PORT="${DEV_SIM_HTTP_PORT:-$((2777 + DEV_PORT_OFFSET))}"

log()  { printf '\033[1;34m[dev-up]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[dev-up]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[dev-up] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$DEV_DB" =~ ^[a-z_][a-z0-9_]*$ ]] || die "DEV_DB must be a plain identifier"
[[ "$DEV_REDIS_DB" =~ ^[0-9]+$ ]] || die "DEV_REDIS_DB must be a number"
[[ "$WEB_MODE" == prod || "$WEB_MODE" == dev ]] || die "WEB_MODE must be prod or dev"
for p in "$API_PORT" "$WEB_PORT" "$ENGINE_HTTP_PORT" "$SMPP_PORT" "$METRICS_PORT" "$SIM_PORT" "$SIM_HTTP_PORT"; do
  if ! [[ "$p" =~ ^[0-9]+$ ]] || ((p < 1 || p > 65535)); then
    die "invalid port $p (check DEV_PORT_OFFSET / DEV_*_PORT)"
  fi
done

# --- preflight -------------------------------------------------------------------------------
for cmd in go node npm psql redis-cli curl jq setsid; do
  command -v "$cmd" >/dev/null || die "$cmd not found in PATH"
done
[[ "$(id -u)" == 0 ]] || die "run as root (db/reset-db.sh uses su postgres)"

mkdir -p "$RUN" "$LOGS" "$BIN"
chmod 700 "$RUN"

for pidf in "$RUN"/*.pid; do
  [[ -e "$pidf" ]] || continue
  if kill -0 "$(cat "$pidf")" 2>/dev/null; then
    die "$(basename "$pidf" .pid) is already running (pid $(cat "$pidf")); run deploy/dev-down.sh first"
  fi
  rm -f "$pidf"
done

port_busy() { ss -Hltn "sport = :$1" 2>/dev/null | grep -q .; }
busy=()
for p in $API_PORT $WEB_PORT $ENGINE_HTTP_PORT $SMPP_PORT $METRICS_PORT $SIM_PORT $SIM_HTTP_PORT; do
  port_busy "$p" && busy+=("$p")
done
((${#busy[@]} == 0)) || die "ports already in use: ${busy[*]} (ss -ltnp | grep -E ':(${busy[*]// /|})\\b')"

redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1 || die "redis not reachable on port $REDIS_PORT"
pg_isready -q -h localhost -p "$PGPORT" || die "postgres not reachable on localhost:$PGPORT"

# From here on, a failure stops whatever was already started.
on_error() {
  local rc=$?
  trap - ERR
  warn "startup failed (exit $rc), stopping started processes"
  "$DEPLOY/dev-down.sh" --quiet || true
  exit "$rc"
}
trap on_error ERR

# --- secrets (generated once, kept in deploy/.run/dev.env) ------------------------------------
SECRETS="$RUN/dev.env"
if [[ ! -s "$SECRETS" ]]; then
  umask 077
  {
    echo "INTERNAL_TOKEN=dev-$(openssl rand -hex 24)"
    echo "APP_ENC_KEY=$(openssl rand -base64 32)"
    echo "JWT_SECRET=$(openssl rand -hex 48)"
  } >"$SECRETS"
  umask 022
  log "generated dev secrets in ${SECRETS#"$ROOT"/}"
fi
set -a
# shellcheck source=/dev/null
source "$SECRETS"
set +a

# Ports of this run, for dev-demo.sh and anyone scripting against the stack.
printf '%s\n' "DEV_API_PORT=$API_PORT" "DEV_WEB_PORT=$WEB_PORT" "DEV_ENGINE_HTTP_PORT=$ENGINE_HTTP_PORT" \
  "DEV_SMPP_PORT=$SMPP_PORT" "DEV_METRICS_PORT=$METRICS_PORT" "DEV_SIM_PORT=$SIM_PORT" \
  "DEV_SIM_HTTP_PORT=$SIM_HTTP_PORT" >"$RUN/ports.env"

DB_ENGINE_URL="postgres://sms_engine_login:sms_engine_dev@localhost:$PGPORT/$DEV_DB"
DB_API_URL="postgres://sms_api_login:sms_api_dev@localhost:$PGPORT/$DEV_DB"
REDIS_URL="redis://localhost:$REDIS_PORT/$DEV_REDIS_DB"

# --- database + redis --------------------------------------------------------------------------
if [[ "$DEV_RESET_DB" == 1 ]]; then
  log "resetting database $DEV_DB (db/reset-db.sh)"
  "$ROOT/db/reset-db.sh" "$DEV_DB" >"$LOGS/db-reset.log" 2>&1 || { cat "$LOGS/db-reset.log" >&2; false; }
  MIGRATE_AS_POSTGRES=1 PGDATABASE="$DEV_DB" MIGRATE_BASELINE=1 "$DEPLOY/migrate.sh" >>"$LOGS/db-reset.log" 2>&1
  log "flushing redis db $DEV_REDIS_DB"
  redis-cli -p "$REDIS_PORT" -n "$DEV_REDIS_DB" FLUSHDB >/dev/null
  rm -f "$RUN/demo.env"
else
  psql "$DB_ENGINE_URL" -XqAt -c 'SELECT 1' >/dev/null 2>&1 \
    || die "DEV_RESET_DB=0 but $DEV_DB is not reachable as sms_engine_login; run once with DEV_RESET_DB=1"
  MIGRATE_AS_POSTGRES=1 PGDATABASE="$DEV_DB" "$DEPLOY/migrate.sh" >>"$LOGS/db-reset.log" 2>&1
fi

# --- builds ------------------------------------------------------------------------------------
log "building engine, smsc-sim, smpp-cli"
(
  cd "$ROOT/engine"
  for c in engine smsc-sim smpp-cli; do
    CGO_ENABLED=0 go build -trimpath -o "$BIN/$c" "./cmd/$c"
  done
) >"$LOGS/build-engine.log" 2>&1 || { cat "$LOGS/build-engine.log" >&2; false; }

# newer_than <stamp> <paths...>: true when any file under paths is newer than stamp (or no stamp).
newer_than() {
  local stamp="$1"; shift
  [[ -e "$stamp" ]] || return 0
  [[ -n "$(find "$@" -newer "$stamp" -type f -print -quit 2>/dev/null)" ]]
}

if [[ ! -d "$ROOT/api/node_modules" ]]; then
  log "installing api dependencies (npm ci)"
  (cd "$ROOT/api" && npm ci --no-audit --no-fund) >"$LOGS/build-api.log" 2>&1 || { cat "$LOGS/build-api.log" >&2; false; }
fi
if newer_than "$ROOT/api/dist/main.js" "$ROOT/api/src" "$ROOT/api/package.json" "$ROOT/api/tsconfig.json" "$ROOT/api/tsconfig.build.json"; then
  log "building api (tsc)"
  (cd "$ROOT/api" && npm run build) >>"$LOGS/build-api.log" 2>&1 || { cat "$LOGS/build-api.log" >&2; false; }
else
  log "api build is up to date"
fi

if [[ ! -d "$ROOT/web/node_modules" ]]; then
  log "installing web dependencies (npm ci)"
  (cd "$ROOT/web" && npm ci --no-audit --no-fund) >"$LOGS/build-web.log" 2>&1 || { cat "$LOGS/build-web.log" >&2; false; }
fi
if [[ "$WEB_MODE" == prod ]]; then
  # .next/BUILD_ID is written at the end of a successful build; rebuild when sources changed
  # or the last build targeted a different API_URL.
  stamp="$ROOT/web/.next/BUILD_ID"
  want_api="http://localhost:$API_PORT"
  built_api="$(cat "$RUN/web-build-api-url" 2>/dev/null || true)"
  if [[ "$built_api" != "$want_api" ]] || newer_than "$stamp" "$ROOT/web/src" "$ROOT/web/package.json" "$ROOT/web/next.config.mjs" "$ROOT/web/tailwind.config.ts"; then
    log "building web (next build, API_URL=$want_api); this takes a minute"
    (cd "$ROOT/web" && API_URL="$want_api" NEXT_TELEMETRY_DISABLED=1 npm run build) >>"$LOGS/build-web.log" 2>&1 \
      || { tail -n 60 "$LOGS/build-web.log" >&2; false; }
    echo "$want_api" >"$RUN/web-build-api-url"
  else
    log "web build is up to date"
  fi
fi

# --- process management ------------------------------------------------------------------------
# start <name> <cwd> <cmd...>: own session/process group (setsid), PID file, log file.
start() {
  local name="$1" cwd="$2"; shift 2
  : >"$LOGS/$name.log"
  ( cd "$cwd" && exec setsid "$@" >>"$LOGS/$name.log" 2>&1 </dev/null ) &
  echo $! >"$RUN/$name.pid"
  log "started $name (pid $!, log ${LOGS#"$ROOT"/}/$name.log)"
}

# wait_http <name> <url> <timeout_s> [curl args...]: until HTTP 2xx; fail fast if the process dies.
wait_http() {
  local name="$1" url="$2" timeout="$3"; shift 3
  local pid; pid="$(cat "$RUN/$name.pid")"
  for ((i = 0; i < timeout * 2; i++)); do
    if curl -fsS -o /dev/null --max-time 2 "$@" "$url" 2>/dev/null; then
      log "$name healthy ($url)"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      warn "$name exited; last log lines:"; tail -n 40 "$LOGS/$name.log" >&2
      return 1
    fi
    sleep 0.5
  done
  warn "$name not healthy after ${timeout}s; last log lines:"; tail -n 40 "$LOGS/$name.log" >&2
  return 1
}

# --- smsc-sim ----------------------------------------------------------------------------------
start smsc-sim "$ROOT" env \
  SMSC_SIM_LISTEN=":$SIM_PORT" SMSC_SIM_HTTP=":$SIM_HTTP_PORT" SMSC_SIM_DLR_DELAY=1s \
  "$BIN/smsc-sim"
wait_http smsc-sim "http://127.0.0.1:$SIM_HTTP_PORT/health" 20

# --- engine ------------------------------------------------------------------------------------
start engine "$ROOT" env \
  DATABASE_URL="$DB_ENGINE_URL" REDIS_URL="$REDIS_URL" \
  INTERNAL_TOKEN="$INTERNAL_TOKEN" APP_ENC_KEY="$APP_ENC_KEY" \
  ENGINE_HTTP_ADDR="127.0.0.1:$ENGINE_HTTP_PORT" ENGINE_SMPP_ADDR=":$SMPP_PORT" \
  ENGINE_METRICS_ADDR="127.0.0.1:$METRICS_PORT" ENGINE_INSTANCE_ID=dev-engine \
  LOG_LEVEL="${LOG_LEVEL:-info}" LOG_FORMAT=text TZ=UTC \
  "$BIN/engine"
wait_http engine "http://127.0.0.1:$ENGINE_HTTP_PORT/internal/v1/health" 40 -H "X-Internal-Token: $INTERNAL_TOKEN"

# --- api (seed admin first: idempotent) --------------------------------------------------------
API_ENV=(
  PORT="$API_PORT"
  DATABASE_URL="$DB_API_URL" DATABASE_URL_PRIVILEGED="$DB_ENGINE_URL" REDIS_URL="$REDIS_URL"
  INTERNAL_TOKEN="$INTERNAL_TOKEN" ENGINE_URL="http://127.0.0.1:$ENGINE_HTTP_PORT"
  ENGINE_METRICS_URL="http://127.0.0.1:$METRICS_PORT/metrics"
  APP_ENC_KEY="$APP_ENC_KEY" JWT_SECRET="$JWT_SECRET" TRUST_PROXY=0
)
log "seeding admin $ADMIN_EMAIL"
(cd "$ROOT/api" && env DATABASE_URL_PRIVILEGED="$DB_ENGINE_URL" ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  node dist/seed.js) >"$LOGS/seed.log" 2>&1 || { cat "$LOGS/seed.log" >&2; false; }
start api "$ROOT/api" env "${API_ENV[@]}" node dist/main.js
wait_http api "http://127.0.0.1:$API_PORT/api/health" 60

# --- web ---------------------------------------------------------------------------------------
if [[ "$WEB_MODE" == prod ]]; then
  start web "$ROOT/web" env PORT="$WEB_PORT" NEXT_TELEMETRY_DISABLED=1 \
    node node_modules/next/dist/bin/next start -p "$WEB_PORT"
  wait_http web "http://127.0.0.1:$WEB_PORT/login" 60
else
  start web "$ROOT/web" env API_URL="http://localhost:$API_PORT" NEXT_TELEMETRY_DISABLED=1 \
    node node_modules/next/dist/bin/next dev -p "$WEB_PORT"
  wait_http web "http://127.0.0.1:$WEB_PORT/login" 180   # first request compiles the page
fi

trap - ERR

# --- demo provisioning + SMS round trip ---------------------------------------------------------
demo_status="skipped (DEV_DEMO=0)"
if [[ "$DEV_DEMO" == 1 && "$DEV_RESET_DB" == 1 ]]; then
  if ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_PASSWORD="$ADMIN_PASSWORD" "$DEPLOY/dev-demo.sh"; then
    demo_status="ok (credentials in ${RUN#"$ROOT"/}/demo.env)"
  else
    demo_status="FAILED (see output above; the stack is still running)"
    warn "demo provisioning / SMS round trip failed"
  fi
elif [[ "$DEV_DEMO" == 1 ]]; then
  demo_status="skipped (DEV_RESET_DB=0); run deploy/dev-demo.sh for a round-trip check"
fi

cat >&2 <<EOF

  SMS gateway dev stack is up              (stop: deploy/dev-down.sh)
  ------------------------------------------------------------------------
  web panel        http://localhost:$WEB_PORT          login $ADMIN_EMAIL / $ADMIN_PASSWORD
  api              http://localhost:$API_PORT/api/health   docs: /api/docs
  public API       http://localhost:$API_PORT/v1/...
  client SMPP      localhost:$SMPP_PORT                     smpp-cli: ${BIN#"$ROOT"/}/smpp-cli
  engine internal  http://127.0.0.1:$ENGINE_HTTP_PORT (X-Internal-Token in ${SECRETS#"$ROOT"/})
  engine metrics   http://127.0.0.1:$METRICS_PORT/metrics
  smsc-sim         SMPP 127.0.0.1:$SIM_PORT, http://127.0.0.1:$SIM_HTTP_PORT/messages
  database         $DEV_DB  ($DB_ENGINE_URL)
  redis            $REDIS_URL
  logs / pids      ${RUN#"$ROOT"/}/logs/*.log, ${RUN#"$ROOT"/}/*.pid
  demo             $demo_status
EOF
