#!/usr/bin/env bash
# deploy/migrate.sh: apply db/migrations/*.sql in filename order, exactly once each.
#
# Applied files are recorded in public.schema_migrations (filename, sha256 checksum, applied_at).
# You can run it again safely: files already applied are skipped. If an applied file's checksum
# has changed, the run stops with an error, because migrations are append-only.
#
# Each file is applied atomically together with its schema_migrations row:
#   - a file that ends with its own top-level `COMMIT;` (our convention: BEGIN; ... COMMIT;) has
#     the tracking INSERT injected just before that last COMMIT;
#   - a file without one is wrapped in BEGIN; ... COMMIT;
#   - a file containing the line `-- migrate:no-transaction` (for CREATE INDEX CONCURRENTLY and
#     similar) runs as-is, then the row is inserted. Keep such files to one statement.
# A session advisory lock serializes concurrent runners, for example two db-init containers.
#
# Usage:
#   deploy/migrate.sh [--status] [--dry-run]
#
# Connection (first one that is set wins):
#   MIGRATE_DATABASE_URL   postgres://owner:pw@host:5432/db   (owner/superuser: migrations create
#                                                              roles, extensions and tables)
#   DATABASE_URL           same
#   MIGRATE_AS_POSTGRES=1 + PGDATABASE=<db>   local peer auth as the `postgres` OS user (runuser)
#   otherwise the libpq PG* variables (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE)
#
# Other env:
#   MIGRATIONS_DIR      default: <repo>/db/migrations (in the db-init container: /migrations)
#   MIGRATE_BASELINE=1  The DB already has the schema (for example it was made by db/reset-db.sh)
#                       but no schema_migrations rows. Record every current file as applied
#                       without running it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-$SCRIPT_DIR/../db/migrations}"
LOCK_KEY="hashtext('smsgw.schema_migrations')"

mode=apply
for arg in "$@"; do
  case "$arg" in
    --status)  mode=status ;;
    --dry-run) mode=dry-run ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "migrate: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

log() { echo "migrate: $*" >&2; }
die() { log "ERROR: $*"; exit 1; }

[[ -d "$MIGRATIONS_DIR" ]] || die "migrations dir not found: $MIGRATIONS_DIR"

# psql invocation (array, so URLs with special characters are never word-split).
url="${MIGRATE_DATABASE_URL:-${DATABASE_URL:-}}"
if [[ -n "$url" ]]; then
  PSQL=(psql "$url")
elif [[ "${MIGRATE_AS_POSTGRES:-0}" == "1" ]]; then
  [[ -n "${PGDATABASE:-}" ]] || die "MIGRATE_AS_POSTGRES=1 needs PGDATABASE"
  PSQL=(runuser -u postgres -- psql -d "$PGDATABASE")
else
  PSQL=(psql)
fi
PSQL+=(-X -q -v ON_ERROR_STOP=1 --no-psqlrc)

checksum() { sha256sum "$1" | cut -d' ' -f1; }

shopt -s nullglob
files=()
for f in "$MIGRATIONS_DIR"/*.sql; do
  name="$(basename "$f")"
  # Filenames are interpolated into SQL string literals: keep them boring.
  [[ "$name" =~ ^[A-Za-z0-9_.-]+\.sql$ ]] || die "refusing unsafe migration filename: $name"
  files+=("$f")
done
shopt -u nullglob
((${#files[@]} > 0)) || die "no *.sql files in $MIGRATIONS_DIR"

# 1. Make sure the tracking table exists (under the lock), then read what has been applied.
"${PSQL[@]}" <<SQL >/dev/null
SET client_min_messages = warning;
SELECT pg_advisory_lock($LOCK_KEY);
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  filename   text PRIMARY KEY,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SELECT pg_advisory_unlock($LOCK_KEY);
SQL

declare -A applied=()
while IFS='|' read -r fname sum; do
  [[ -n "$fname" ]] && applied["$fname"]="$sum"
done < <("${PSQL[@]}" -At -c "SELECT filename || '|' || checksum FROM public.schema_migrations ORDER BY filename")

# 2. Checksums of applied files must not change; build the pending list.
pending=()
for f in "${files[@]}"; do
  name="$(basename "$f")"
  sum="$(checksum "$f")"
  if [[ -n "${applied[$name]:-}" ]]; then
    [[ "${applied[$name]}" == "$sum" ]] \
      || die "$name was already applied but its content changed (recorded ${applied[$name]:0:12}…, now ${sum:0:12}…). Migrations are append-only: add a new file instead."
  else
    pending+=("$f")
  fi
done
for name in "${!applied[@]}"; do
  [[ -f "$MIGRATIONS_DIR/$name" ]] || log "warning: $name is recorded as applied but missing from $MIGRATIONS_DIR"
done

if [[ "$mode" == "status" || "$mode" == "dry-run" ]]; then
  for f in "${files[@]}"; do
    name="$(basename "$f")"
    if [[ -n "${applied[$name]:-}" ]]; then echo "applied  $name"; else echo "pending  $name"; fi
  done
  exit 0
fi

if ((${#pending[@]} == 0)); then
  log "up to date (${#files[@]} files applied)"
  exit 0
fi

# 3. Existing schema without tracking rows: refuse to re-run 001 on top of it unless baselining.
has_schema="$("${PSQL[@]}" -At -c "SELECT to_regclass('public.organizations') IS NOT NULL")"
if ((${#applied[@]} == 0)) && [[ "$has_schema" == "t" ]]; then
  if [[ "${MIGRATE_BASELINE:-0}" != "1" ]]; then
    die "database already has the schema but no schema_migrations rows. If it is fully migrated (e.g. made by db/reset-db.sh), re-run with MIGRATE_BASELINE=1 to record the current files without running them."
  fi
  {
    echo "SELECT pg_advisory_lock($LOCK_KEY);"
    echo "BEGIN;"
    for f in "${files[@]}"; do
      echo "INSERT INTO public.schema_migrations (filename, checksum) VALUES ('$(basename "$f")', '$(checksum "$f")') ON CONFLICT (filename) DO NOTHING;"
    done
    echo "COMMIT;"
    echo "SELECT pg_advisory_unlock($LOCK_KEY);"
  } | "${PSQL[@]}" >/dev/null
  log "baselined ${#files[@]} files as applied"
  exit 0
fi

# 4. Apply pending files in one session holding the advisory lock. Each file re-checks under
#    the lock, so a concurrent runner that got there first is skipped instead of failing.
emit_file() {  # emit_file <path>: file SQL with the tracking INSERT folded into its transaction
  local f="$1" name sum insert last_commit
  name="$(basename "$f")"
  sum="$(checksum "$f")"
  insert="INSERT INTO public.schema_migrations (filename, checksum) VALUES ('$name', '$sum');"
  if grep -qE '^--[[:space:]]*migrate:no-transaction[[:space:]]*$' "$f"; then
    cat "$f"; echo; echo "$insert"
    return
  fi
  last_commit="$(grep -nE '^[[:space:]]*COMMIT[[:space:]]*;[[:space:]]*$' "$f" | tail -n1 | cut -d: -f1 || true)"
  if [[ -n "$last_commit" ]]; then
    awk -v n="$last_commit" -v ins="$insert" 'NR == n { print ins } { print }' "$f"
  else
    echo "BEGIN;"; cat "$f"; echo; echo "$insert"; echo "COMMIT;"
  fi
}

rc_file="$(mktemp)"
trap 'rm -f "$rc_file"' EXIT
{
  echo "SET client_min_messages = warning;"
  echo "SELECT pg_advisory_lock($LOCK_KEY) \\gset lock_"
  for f in "${pending[@]}"; do
    name="$(basename "$f")"
    echo "SELECT NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE filename = '$name') AS migrate_pending \\gset"
    echo "\\if :migrate_pending"
    echo "\\echo 'migrate: applying $name'"
    emit_file "$f"
    echo
    echo "\\else"
    echo "\\echo 'migrate: $name already applied by a concurrent run'"
    echo "\\endif"
  done
  echo "SELECT pg_advisory_unlock($LOCK_KEY) \\gset lock_"
} | { set +e; "${PSQL[@]}" 2>&1; echo "$?" >"$rc_file"; } | sed 's/^/  /' >&2
rc="$(cat "$rc_file")"
((rc == 0)) || die "psql exited with status $rc; the failing file's transaction was rolled back"
log "done (${#pending[@]} applied, $((${#files[@]} - ${#pending[@]})) already present)"
