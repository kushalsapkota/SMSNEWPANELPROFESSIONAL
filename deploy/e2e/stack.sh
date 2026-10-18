#!/usr/bin/env bash
# deploy/e2e/stack.sh: run an isolated full stack for deploy/e2e.sh, next to (not instead of) the
# dev stack of deploy/dev-up.sh. Everything uses its own DB, Redis DB index and ports:
#
#   deploy/e2e/stack.sh up      fresh DB + Redis DB, build, start 2× smsc-sim, engine, api, web,
#                               webhook receiver; wait for every health check
#   deploy/e2e/stack.sh down    stop everything this script started (process groups, by PID)
#   deploy/e2e/stack.sh status  show which processes are running
#
# Env (defaults in brackets):
#   E2E_DB [sms_e2e]  E2E_REDIS_DB [3]  REDIS_PORT [6399]  PGPORT [5432]
#   E2E_API_PORT [3100]  E2E_WEB_PORT [3101]  E2E_ENGINE_PORT [8181]  E2E_SMPP_PORT [2875]
#   E2E_METRICS_PORT [9200]  E2E_SIM1_PORT [2876]  E2E_SIM1_HTTP [2877]  E2E_SIM2_PORT [2886]
#   E2E_SIM2_HTTP [2887]  E2E_HOOK_PORT [2899]
#   E2E_SKIP_WEB=1   do not build/start the web panel
#
# Runtime state (PIDs, logs, binaries, secrets, the web build copy) lives in deploy/e2e/.run.
# The web is built from a copy of web/ (node_modules symlinked) because next.config bakes API_URL
# into the build, and the dev stack's web/.next must not be overwritten.
set -Eeuo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$E2E_DIR/../.." && pwd)"
RUN="$E2E_DIR/.run"
LOGS="$RUN/logs"
BIN="$RUN/bin"

E2E_DB="${E2E_DB:-sms_e2e}"
E2E_REDIS_DB="${E2E_REDIS_DB:-3}"
REDIS_PORT="${REDIS_PORT:-6399}"
PGPORT="${PGPORT:-5432}"
API_PORT="${E2E_API_PORT:-3100}"
WEB_PORT="${E2E_WEB_PORT:-3101}"
ENGINE_PORT="${E2E_ENGINE_PORT:-8181}"
SMPP_PORT="${E2E_SMPP_PORT:-2875}"
METRICS_PORT="${E2E_METRICS_PORT:-9200}"
SIM1_PORT="${E2E_SIM1_PORT:-2876}"
SIM1_HTTP="${E2E_SIM1_HTTP:-2877}"
SIM2_PORT="${E2E_SIM2_PORT:-2886}"
SIM2_HTTP="${E2E_SIM2_HTTP:-2887}"
HOOK_PORT="${E2E_HOOK_PORT:-2899}"
SKIP_WEB="${E2E_SKIP_WEB:-0}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@smsgw.local}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-Admin-Passw0rd!}"

SERVICES=(web api engine sim2 sim1 hook)   # stop order

log()  { printf '\033[1;34m[e2e-stack]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[e2e-stack]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[e2e-stack] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

stop_one() {
  local name="$1" pidf="$RUN/$1.pid" pid pgid target
  [[ -f "$pidf" ]] || return 0
  pid="$(cat "$pidf")"
  if [[ ! "$pid" =~ ^[0-9]+$ ]] || ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$pidf"; return 0
  fi
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
  target="$pid"; [[ "$pgid" == "$pid" ]] && target="-$pid"
  log "stopping $name (pid $pid)"
  kill -TERM -- "$target" 2>/dev/null || true
  for ((i = 0; i < 100; i++)); do
    if ! kill -0 "$pid" 2>/dev/null && { [[ "$target" != -* ]] || ! pgrep -g "$pid" >/dev/null 2>&1; }; then
      rm -f "$pidf"; return 0
    fi
    sleep 0.25
  done
  warn "$name did not exit in 25s; SIGKILL"
  kill -KILL -- "$target" 2>/dev/null || true
  sleep 0.3
  rm -f "$pidf"
}

cmd_down() { for s in "${SERVICES[@]}"; do stop_one "$s"; done; }

cmd_status() {
  for s in "${SERVICES[@]}"; do
    if [[ -f "$RUN/$s.pid" ]] && kill -0 "$(cat "$RUN/$s.pid")" 2>/dev/null; then
      echo "$s running (pid $(cat "$RUN/$s.pid"))"
    else
      echo "$s stopped"
    fi
  done
}

start() {  # start <name> <cwd> <cmd...>
  local name="$1" cwd="$2"; shift 2
  : >"$LOGS/$name.log"
  ( cd "$cwd" && exec setsid "$@" >>"$LOGS/$name.log" 2>&1 </dev/null ) &
  echo $! >"$RUN/$name.pid"
  log "started $name (pid $!)"
}

wait_http() {  # wait_http <name> <url> <timeout_s> [curl args]
  local name="$1" url="$2" timeout="$3"; shift 3
  local pid; pid="$(cat "$RUN/$name.pid")"
  for ((i = 0; i < timeout * 2; i++)); do
    curl -fsS -o /dev/null --max-time 2 "$@" "$url" 2>/dev/null && { log "$name healthy"; return 0; }
    kill -0 "$pid" 2>/dev/null || { warn "$name exited:"; tail -n 40 "$LOGS/$name.log" >&2; return 1; }
    sleep 0.5
  done
  warn "$name not healthy after ${timeout}s:"; tail -n 40 "$LOGS/$name.log" >&2
  return 1
}

port_busy() { ss -Hltn "sport = :$1" 2>/dev/null | grep -q .; }

cmd_up() {
  for c in go node npm psql redis-cli curl jq setsid rsync python3 openssl; do
    command -v "$c" >/dev/null || die "$c not found"
  done
  mkdir -p "$RUN" "$LOGS" "$BIN"
  chmod 700 "$RUN"
  for s in "${SERVICES[@]}"; do
    [[ -f "$RUN/$s.pid" ]] && kill -0 "$(cat "$RUN/$s.pid")" 2>/dev/null && die "$s already running; run '$0 down' first"
    rm -f "$RUN/$s.pid"
  done
  local busy=()
  for p in "$API_PORT" "$WEB_PORT" "$ENGINE_PORT" "$SMPP_PORT" "$METRICS_PORT" "$SIM1_PORT" "$SIM1_HTTP" "$SIM2_PORT" "$SIM2_HTTP" "$HOOK_PORT"; do
    port_busy "$p" && busy+=("$p")
  done
  ((${#busy[@]} == 0)) || die "ports in use: ${busy[*]}"

  trap 'rc=$?; trap - ERR; warn "startup failed ($rc); stopping"; cmd_down; exit $rc' ERR

  umask 077
  {
    echo "INTERNAL_TOKEN=e2e-$(openssl rand -hex 24)"
    echo "APP_ENC_KEY=$(openssl rand -base64 32)"
    echo "JWT_SECRET=$(openssl rand -hex 48)"
  } >"$RUN/secrets.env"
  umask 022
  set -a; source "$RUN/secrets.env"; set +a

  local db_engine="postgres://sms_engine_login:sms_engine_dev@localhost:$PGPORT/$E2E_DB"
  local db_api="postgres://sms_api_login:sms_api_dev@localhost:$PGPORT/$E2E_DB"
  local redis_url="redis://localhost:$REDIS_PORT/$E2E_REDIS_DB"

  log "resetting database $E2E_DB and redis db $E2E_REDIS_DB"
  "$ROOT/db/reset-db.sh" "$E2E_DB" >"$LOGS/db-reset.log" 2>&1 || { cat "$LOGS/db-reset.log" >&2; false; }
  redis-cli -p "$REDIS_PORT" -n "$E2E_REDIS_DB" FLUSHDB >/dev/null

  log "building engine, smsc-sim, smpp-cli"
  (cd "$ROOT/engine" && for c in engine smsc-sim smpp-cli; do CGO_ENABLED=0 go build -trimpath -o "$BIN/$c" "./cmd/$c"; done) \
    >"$LOGS/build-engine.log" 2>&1 || { cat "$LOGS/build-engine.log" >&2; false; }

  log "building api"
  [[ -d "$ROOT/api/node_modules" ]] || (cd "$ROOT/api" && npm ci --no-audit --no-fund) >"$LOGS/build-api.log" 2>&1
  (cd "$ROOT/api" && npm run build) >>"$LOGS/build-api.log" 2>&1 || { tail -n 60 "$LOGS/build-api.log" >&2; false; }

  if [[ "$SKIP_WEB" != 1 ]]; then
    log "building web copy (API_URL=http://localhost:$API_PORT)"
    [[ -d "$ROOT/web/node_modules" ]] || (cd "$ROOT/web" && npm ci --no-audit --no-fund) >"$LOGS/build-web.log" 2>&1
    mkdir -p "$RUN/web"
    rsync -a --delete --exclude node_modules --exclude .next --exclude coverage "$ROOT/web/" "$RUN/web/"
    ln -sfn "$ROOT/web/node_modules" "$RUN/web/node_modules"
    (cd "$RUN/web" && API_URL="http://localhost:$API_PORT" NEXT_TELEMETRY_DISABLED=1 node node_modules/next/dist/bin/next build) \
      >"$LOGS/build-web.log" 2>&1 || { tail -n 60 "$LOGS/build-web.log" >&2; false; }
  fi

  start hook "$E2E_DIR" python3 -I "$E2E_DIR/webhook_receiver.py" --port "$HOOK_PORT" --out "$RUN/webhooks.jsonl"
  wait_http hook "http://127.0.0.1:$HOOK_PORT/health" 10

  start sim1 "$RUN" env SMSC_SIM_LISTEN="127.0.0.1:$SIM1_PORT" SMSC_SIM_HTTP="127.0.0.1:$SIM1_HTTP" SMSC_SIM_DLR_DELAY=500ms "$BIN/smsc-sim"
  wait_http sim1 "http://127.0.0.1:$SIM1_HTTP/health" 15
  # sim2 is the failover target: it accepts …1111 destinations (sim1 rejects them).
  start sim2 "$RUN" env SMSC_SIM_LISTEN="127.0.0.1:$SIM2_PORT" SMSC_SIM_HTTP="127.0.0.1:$SIM2_HTTP" SMSC_SIM_DLR_DELAY=500ms SMSC_SIM_ACCEPT_ALL=1 "$BIN/smsc-sim"
  wait_http sim2 "http://127.0.0.1:$SIM2_HTTP/health" 15

  start engine "$RUN" env \
    DATABASE_URL="$db_engine" REDIS_URL="$redis_url" INTERNAL_TOKEN="$INTERNAL_TOKEN" APP_ENC_KEY="$APP_ENC_KEY" \
    ENGINE_HTTP_ADDR="127.0.0.1:$ENGINE_PORT" ENGINE_SMPP_ADDR="127.0.0.1:$SMPP_PORT" \
    ENGINE_METRICS_ADDR="127.0.0.1:$METRICS_PORT" ENGINE_INSTANCE_ID=e2e-engine \
    WEBHOOK_ALLOW_PRIVATE_TARGETS=1 \
    LOG_LEVEL="${LOG_LEVEL:-info}" LOG_FORMAT=text TZ=UTC "$BIN/engine"
  wait_http engine "http://127.0.0.1:$ENGINE_PORT/internal/v1/health" 40 -H "X-Internal-Token: $INTERNAL_TOKEN"

  log "seeding admin $ADMIN_EMAIL"
  (cd "$ROOT/api" && env DATABASE_URL_PRIVILEGED="$db_engine" ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_PASSWORD="$ADMIN_PASSWORD" node dist/seed.js) \
    >"$LOGS/seed.log" 2>&1 || { cat "$LOGS/seed.log" >&2; false; }

  start api "$ROOT/api" env PORT="$API_PORT" \
    DATABASE_URL="$db_api" DATABASE_URL_PRIVILEGED="$db_engine" REDIS_URL="$redis_url" \
    INTERNAL_TOKEN="$INTERNAL_TOKEN" ENGINE_URL="http://127.0.0.1:$ENGINE_PORT" \
    ENGINE_METRICS_URL="http://127.0.0.1:$METRICS_PORT/metrics" \
    APP_ENC_KEY="$APP_ENC_KEY" JWT_SECRET="$JWT_SECRET" TRUST_PROXY=0 \
    WEBHOOK_ALLOW_PRIVATE_TARGETS=1 node dist/main.js
  wait_http api "http://127.0.0.1:$API_PORT/api/health" 60

  if [[ "$SKIP_WEB" != 1 ]]; then
    start web "$RUN/web" env PORT="$WEB_PORT" NEXT_TELEMETRY_DISABLED=1 node node_modules/next/dist/bin/next start -p "$WEB_PORT"
    wait_http web "http://127.0.0.1:$WEB_PORT/login" 60
  fi
  trap - ERR

  cat >"$RUN/stack.env" <<EOF
E2E_DB=$E2E_DB
E2E_REDIS_DB=$E2E_REDIS_DB
REDIS_PORT=$REDIS_PORT
E2E_API_PORT=$API_PORT
E2E_WEB_PORT=$WEB_PORT
E2E_ENGINE_PORT=$ENGINE_PORT
E2E_SMPP_PORT=$SMPP_PORT
E2E_METRICS_PORT=$METRICS_PORT
E2E_SIM1_PORT=$SIM1_PORT
E2E_SIM1_HTTP=$SIM1_HTTP
E2E_SIM2_PORT=$SIM2_PORT
E2E_SIM2_HTTP=$SIM2_HTTP
E2E_HOOK_PORT=$HOOK_PORT
E2E_SKIP_WEB=$SKIP_WEB
EOF
  log "stack up: api :$API_PORT, web :$WEB_PORT, engine :$ENGINE_PORT, smpp :$SMPP_PORT, sims :$SIM1_PORT/:$SIM2_PORT, hooks :$HOOK_PORT"
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  *) echo "usage: $0 up|down|status" >&2; exit 2 ;;
esac
