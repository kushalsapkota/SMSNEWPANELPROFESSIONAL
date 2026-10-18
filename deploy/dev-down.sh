#!/usr/bin/env bash
# deploy/dev-down.sh: stop everything deploy/dev-up.sh started (web, api, engine, smsc-sim).
#
# Each process was started in its own process group (setsid), so the whole group gets the signal,
# including child processes such as Next.js workers. Order: web → api → engine → smsc-sim, so
# the engine can drain and flush CDRs while its upstream is still there. SIGTERM, wait up to
# DEV_DOWN_TIMEOUT seconds (default 25), then SIGKILL.
#
#   deploy/dev-down.sh            stop; keep DB sms_dev, Redis data and logs for inspection
#   deploy/dev-down.sh --purge    also drop DEV_DB, flush DEV_REDIS_DB, delete deploy/.run/logs
#   --quiet                       less output (used by dev-up on failure)
set -euo pipefail

DEPLOY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$DEPLOY/.run"
TIMEOUT="${DEV_DOWN_TIMEOUT:-25}"
DEV_DB="${DEV_DB:-sms_dev}"
DEV_REDIS_DB="${DEV_REDIS_DB:-6}"
REDIS_PORT="${REDIS_PORT:-6399}"

purge=0 quiet=0
for arg in "$@"; do
  case "$arg" in
    --purge) purge=1 ;;
    --quiet) quiet=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "dev-down: unknown argument $arg" >&2; exit 2 ;;
  esac
done
log() { ((quiet)) || printf '\033[1;34m[dev-down]\033[0m %s\n' "$*" >&2; }

# stop <name>: signal the process group recorded in <name>.pid
stop() {
  local name="$1" pidf="$RUN/$1.pid" pid
  [[ -f "$pidf" ]] || return 0
  pid="$(cat "$pidf")"
  if [[ ! "$pid" =~ ^[0-9]+$ ]] || ! kill -0 "$pid" 2>/dev/null; then
    log "$name not running"
    rm -f "$pidf"
    return 0
  fi
  # dev-up starts each service as a session leader, so pgid == pid. Only signal the group when
  # that still holds. If the pid was recycled by an unrelated process, leave it alone.
  local pgid
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
  local target="$pid"
  [[ "$pgid" == "$pid" ]] && target="-$pid"
  log "stopping $name (pid $pid)"
  kill -TERM -- "$target" 2>/dev/null || true
  for ((i = 0; i < TIMEOUT * 4; i++)); do
    if ! kill -0 "$pid" 2>/dev/null && { [[ "$target" != -* ]] || ! pgrep -g "$pid" >/dev/null 2>&1; }; then
      rm -f "$pidf"
      return 0
    fi
    sleep 0.25
  done
  log "$name did not exit within ${TIMEOUT}s; sending SIGKILL"
  kill -KILL -- "$target" 2>/dev/null || true
  sleep 0.5
  rm -f "$pidf"
}

if [[ -d "$RUN" ]]; then
  for name in web api engine smsc-sim; do
    stop "$name"
  done
  # Anything else dev-up may add later.
  for pidf in "$RUN"/*.pid; do
    if [[ -e "$pidf" ]]; then stop "$(basename "$pidf" .pid)"; fi
  done
fi

if ((purge)); then
  [[ "$DEV_DB" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "dev-down: DEV_DB must be a plain identifier" >&2; exit 2; }
  [[ "$DEV_REDIS_DB" =~ ^[0-9]+$ ]] || { echo "dev-down: DEV_REDIS_DB must be a number" >&2; exit 2; }
  log "purging database $DEV_DB and redis db $DEV_REDIS_DB"
  su postgres -c "psql -qAt -c 'DROP DATABASE IF EXISTS \"$DEV_DB\" WITH (FORCE)'" >/dev/null
  redis-cli -p "$REDIS_PORT" -n "$DEV_REDIS_DB" FLUSHDB >/dev/null 2>&1 || true
  rm -rf "$RUN/logs" "$RUN/demo.env" "$RUN/web-build-api-url" "$RUN/ports.env"
fi
log "stopped"
