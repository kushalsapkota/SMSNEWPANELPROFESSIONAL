#!/usr/bin/env bash
# deploy/test-go.sh: run every engine Go test with the race detector, against fresh databases.
#
# The engine's integration tests default to two fixtures (CONTRACTS §1):
#   core  (billing, store, ratelimit, config):      Postgres sms_core, Redis DB 1
#   flow  (cdr, dispatch, dlr, pipeline, webhook, e2e): Postgres sms_flow, Redis DB 2
# Packages are put in a group by the fixture their tests name (grep for sms_core). Each group runs
# as one `go test -race` invocation with TEST_DATABASE_URL / TEST_REDIS_URL (and E2E_* for e2e)
# pointing at that group's fixture. Packages with no infrastructure run with the flow group.
#
# Env:
#   GO_TEST_DB_CORE=sms_core  GO_TEST_DB_FLOW=sms_flow    database names
#   GO_TEST_REDIS_CORE=1      GO_TEST_REDIS_FLOW=2        Redis DB indexes (port REDIS_PORT=6399)
#   GO_TEST_RESET_DB=1        recreate both DBs with db/reset-db.sh first (needs root)
#   GO_TEST_FLAGS="-count=1"  extra go test flags (e.g. "-run TestX -v")
set -euo pipefail

DEPLOY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DEPLOY/.." && pwd)"
ENGINE="$ROOT/engine"

CORE_DB="${GO_TEST_DB_CORE:-sms_core}"
FLOW_DB="${GO_TEST_DB_FLOW:-sms_flow}"
CORE_REDIS="${GO_TEST_REDIS_CORE:-1}"
FLOW_REDIS="${GO_TEST_REDIS_FLOW:-2}"
REDIS_PORT="${REDIS_PORT:-6399}"
PGPORT="${PGPORT:-5432}"
read -r -a FLAGS <<<"${GO_TEST_FLAGS:--count=1}"

log() { echo "test-go: $*" >&2; }

if [[ "${GO_TEST_RESET_DB:-1}" == 1 ]]; then
  for db in "$CORE_DB" "$FLOW_DB"; do
    log "resetting $db"
    "$ROOT/db/reset-db.sh" "$db" >/dev/null
  done
fi

cd "$ENGINE"
core=() flow=()
while IFS='|' read -r pkg dir; do
  if ! compgen -G "$dir/*_test.go" >/dev/null; then
    continue
  fi
  if grep -lq 'sms_core' "$dir"/*_test.go; then core+=("$pkg"); else flow+=("$pkg"); fi
done < <(go list -f '{{.ImportPath}}|{{.Dir}}' ./...)

url() { echo "postgres://sms_engine_login:sms_engine_dev@localhost:$PGPORT/$1"; }

rc=0
log "core group (${#core[@]} packages) → $CORE_DB, redis db $CORE_REDIS"
TEST_DATABASE_URL="$(url "$CORE_DB")" TEST_REDIS_URL="redis://localhost:$REDIS_PORT/$CORE_REDIS" \
  go test -race "${FLAGS[@]}" "${core[@]}" || rc=1

log "flow group (${#flow[@]} packages) → $FLOW_DB, redis db $FLOW_REDIS"
TEST_DATABASE_URL="$(url "$FLOW_DB")" TEST_REDIS_URL="redis://localhost:$REDIS_PORT/$FLOW_REDIS" \
E2E_DATABASE_URL="$(url "$FLOW_DB")" E2E_REDIS_URL="redis://localhost:$REDIS_PORT/$FLOW_REDIS" \
  go test -race "${FLAGS[@]}" "${flow[@]}" || rc=1

if ((rc == 0)); then log "ALL GO TESTS PASSED"; else log "GO TESTS FAILED"; fi
exit "$rc"
