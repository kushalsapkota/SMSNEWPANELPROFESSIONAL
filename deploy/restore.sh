#!/usr/bin/env bash
# SMS gateway: restore a backup produced by deploy/backup.sh.
#
# DANGER: restoring over a live database overwrites data. By default this refuses to touch the
# production database name and restores into a throwaway verification database instead, which is
# how you should regularly test that backups are actually restorable.
#
# Usage:
#   deploy/restore.sh deploy/.backups/sms_gateway_20260101T000000Z.dump.gz
#     -> restores into database "<db>_restore_check" (safe; proves the dump is good)
#
#   TARGET_DB=sms_gateway FORCE=1 deploy/restore.sh <dump>
#     -> restores into the real database (only with both set; it is dropped and recreated)
#
# Env:
#   PG_CONTAINER   compose postgres container (default: smsgw-postgres-1)
#   POSTGRES_USER  role (default: sms_owner)
#   POSTGRES_DB    production database name, used for the default safe target (default: sms_gateway)
#   TARGET_DB      database to restore into (default: ${POSTGRES_DB}_restore_check)
#   FORCE          must be 1 to allow TARGET_DB to equal POSTGRES_DB
set -euo pipefail

dump="${1:-}"
[[ -n "$dump" && -f "$dump" ]] || { echo "usage: deploy/restore.sh <dump.gz>" >&2; exit 2; }

PG_CONTAINER="${PG_CONTAINER:-smsgw-postgres-1}"
POSTGRES_USER="${POSTGRES_USER:-sms_owner}"
POSTGRES_DB="${POSTGRES_DB:-sms_gateway}"
TARGET_DB="${TARGET_DB:-${POSTGRES_DB}_restore_check}"

if [[ "$TARGET_DB" == "$POSTGRES_DB" && "${FORCE:-0}" != "1" ]]; then
  echo "restore: refusing to overwrite production database '$POSTGRES_DB' without FORCE=1" >&2
  exit 3
fi

if [[ -f "$dump.sha256" ]]; then
  echo "restore: verifying checksum"
  ( cd "$(dirname "$dump")" && sha256sum -c "$(basename "$dump").sha256" )
fi

psql() { docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres "$@"; }

echo "restore: (re)creating database '$TARGET_DB'"
psql -c "DROP DATABASE IF EXISTS \"$TARGET_DB\" WITH (FORCE)"
psql -c "CREATE DATABASE \"$TARGET_DB\""

echo "restore: loading dump into '$TARGET_DB'"
gzip -dc "$dump" | docker exec -i "$PG_CONTAINER" pg_restore --no-owner --no-privileges \
  --exit-on-error -U "$POSTGRES_USER" -d "$TARGET_DB"

tables="$(docker exec -i "$PG_CONTAINER" psql -qAt -U "$POSTGRES_USER" -d "$TARGET_DB" \
  -c "SELECT count(*) FROM information_schema.tables WHERE table_schema IN ('public','app')")"
echo "restore: ok — '$TARGET_DB' now has $tables tables in public+app"
[[ "$TARGET_DB" != "$POSTGRES_DB" ]] && echo "restore: this was a verification restore; drop '$TARGET_DB' when done"
