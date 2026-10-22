#!/usr/bin/env bash
# SMS gateway: logical database backup (pg_dump custom format), gzip-compressed, with rotation.
#
# This is the baseline, always-available backup. For point-in-time recovery, also enable
# continuous WAL archiving on the server (see deploy/BACKUP.md) — this script does NOT replace it.
#
# Usage:
#   deploy/backup.sh                         # back up via the running compose postgres container
#   BACKUP_DIR=/srv/backups deploy/backup.sh # choose the output directory
#   PG_CONTAINER=smsgw-postgres-1 deploy/backup.sh
#   DATABASE_URL=postgres://user:pw@host/db deploy/backup.sh   # back up a reachable DB directly
#
# Env:
#   BACKUP_DIR        output directory (default: deploy/.backups)
#   RETENTION_DAYS    delete dumps older than this many days (default: 14; 0 disables)
#   PG_CONTAINER      compose postgres container to exec into (default: smsgw-postgres-1)
#   POSTGRES_DB       database name when using the container path (default: sms_gateway)
#   POSTGRES_USER     role when using the container path (default: sms_owner)
#   DATABASE_URL      if set, dump this connection string directly with the host pg_dump instead
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
PG_CONTAINER="${PG_CONTAINER:-smsgw-postgres-1}"
POSTGRES_DB="${POSTGRES_DB:-sms_gateway}"
POSTGRES_USER="${POSTGRES_USER:-sms_owner}"

mkdir -p "$BACKUP_DIR"
ts="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/${POSTGRES_DB}_${ts}.dump.gz"
tmp="$out.part"

echo "backup: writing $out"
# -Fc custom format: supports selective, parallel restore; piped through gzip for size.
if [[ -n "${DATABASE_URL:-}" ]]; then
  pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" | gzip -c > "$tmp"
else
  docker exec -i "$PG_CONTAINER" pg_dump --format=custom --no-owner --no-privileges \
    -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip -c > "$tmp"
fi

# Reject a truncated/empty dump before it replaces anything.
if [[ ! -s "$tmp" ]] || [[ "$(stat -c%s "$tmp")" -lt 1024 ]]; then
  rm -f "$tmp"
  echo "backup: FAILED — dump was empty or implausibly small" >&2
  exit 1
fi
mv "$tmp" "$out"
sha256sum "$out" > "$out.sha256"
echo "backup: ok ($(du -h "$out" | cut -f1)), checksum $out.sha256"

if [[ "$RETENTION_DAYS" -gt 0 ]]; then
  find "$BACKUP_DIR" -maxdepth 1 -name "${POSTGRES_DB}_*.dump.gz*" -type f -mtime "+$RETENTION_DAYS" -print -delete \
    | sed 's/^/backup: pruned /' || true
fi
