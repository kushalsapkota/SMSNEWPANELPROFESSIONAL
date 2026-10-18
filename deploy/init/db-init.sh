#!/usr/bin/env bash
# deploy/init/db-init.sh: the one-shot `db-init` container (docker-compose.prod.yml).
#   1. wait for Postgres
#   2. deploy/migrate.sh: apply db/migrations in order, tracked in schema_migrations
#   3. deploy/init/init-roles.sh: create or update the login roles from env
#   4. deploy/init/maintenance.sh: make sure the message_logs partitions exist
# You can run it more than once; every step does nothing when there is nothing to do.
# It connects with the libpq PG* variables (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE)
# as the database owner, which is a superuser.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$(cd "$DIR/.." && pwd)"

timeout="${DB_INIT_WAIT_SECONDS:-120}"
echo "db-init: waiting for postgres at ${PGHOST:-localhost}:${PGPORT:-5432} (up to ${timeout}s)" >&2
for ((i = 0; i < timeout; i++)); do
  if pg_isready -q -t 2 && psql -X -qAt -c 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
psql -X -qAt -c 'SELECT 1' >/dev/null || { echo "db-init: ERROR: postgres not reachable" >&2; exit 1; }

"$DEPLOY/migrate.sh"
"$DIR/init-roles.sh"
"$DIR/maintenance.sh"
echo "db-init: complete" >&2
