#!/usr/bin/env bash
# Usage: db/reset-db.sh <dbname>   — drops, recreates, migrates, adds dev login roles.
# Then connect with:
#   tenant (RLS):      postgres://sms_api_login:sms_api_dev@localhost:5432/<dbname>
#   engine/privileged: postgres://sms_engine_login:sms_engine_dev@localhost:5432/<dbname>
set -euo pipefail
DB="${1:?db name}"
DIR="$(cd "$(dirname "$0")" && pwd)"
psqlsu() { su postgres -c "psql -qAt -v ON_ERROR_STOP=1 $*"; }
psqlsu "-c 'DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)' -c 'CREATE DATABASE \"$DB\"'" >/dev/null
for f in "$DIR"/migrations/*.sql; do psqlsu "-d $DB" < "$f" >/dev/null; done
psqlsu "-d $DB" < "$DIR/dev-roles.sql" >/dev/null
psqlsu "-d $DB -c 'GRANT CONNECT ON DATABASE \"$DB\" TO sms_api_login, sms_engine_login'" >/dev/null
echo "ready: $DB"
