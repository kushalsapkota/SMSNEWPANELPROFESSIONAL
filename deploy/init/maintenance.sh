#!/usr/bin/env bash
# deploy/init/maintenance.sh: routine database maintenance. Run it daily (cron) or let the
# `db-maint` compose service run it in a loop. Every step is safe to run again.
#   - creates message_logs monthly partitions from last month through MAINT_PARTITION_MONTHS (default 3)
#     months after the current one
#     (app.ensure_message_log_partitions; the migration only creates 5 months)
#   - drops partitions older than MESSAGE_LOG_RETENTION when it is set (for example "13 months")
#   - warns (exit status 3 when MAINT_STRICT=1) if rows landed in message_logs_default, which
#     means partition creation fell behind
# Connect as the schema owner: creating and dropping partitions needs table ownership.
# Connection: MIGRATE_DATABASE_URL | DATABASE_URL | MIGRATE_AS_POSTGRES=1 + PGDATABASE | PG* vars.
set -euo pipefail

months="${MAINT_PARTITION_MONTHS:-3}"
retention="${MESSAGE_LOG_RETENTION:-}"
[[ "$months" =~ ^[0-9]+$ ]] && ((months >= 1 && months <= 36)) || { echo "maintenance: MAINT_PARTITION_MONTHS must be 1-36" >&2; exit 2; }
if [[ -n "$retention" && ! "$retention" =~ ^[0-9]+\ (month|months|year|years|day|days)$ ]]; then
  echo "maintenance: MESSAGE_LOG_RETENTION must look like '13 months' (got '$retention')" >&2; exit 2
fi

url="${MIGRATE_DATABASE_URL:-${DATABASE_URL:-}}"
if [[ -n "$url" ]]; then
  PSQL=(psql "$url")
elif [[ "${MIGRATE_AS_POSTGRES:-0}" == "1" ]]; then
  PSQL=(runuser -u postgres -- psql -d "${PGDATABASE:?MIGRATE_AS_POSTGRES=1 needs PGDATABASE}")
else
  PSQL=(psql)
fi
PSQL+=(-X -qAt -v ON_ERROR_STOP=1 --no-psqlrc)

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Range: last month (late DLRs, clock skew) + the current month + $months ahead.
created="$("${PSQL[@]}" -c "SELECT app.ensure_message_log_partitions((date_trunc('month', current_date) - interval '1 month')::date, $((months + 2)))")"
echo "$(ts) maintenance: message_logs partitions created: $created" >&2

if [[ -n "$retention" ]]; then
  dropped="$("${PSQL[@]}" -c "SELECT app.drop_message_log_partitions('$retention'::interval)")"
  echo "$(ts) maintenance: message_logs partitions dropped (retention $retention): $dropped" >&2
fi

stray="$("${PSQL[@]}" -c "SELECT count(*) FROM message_logs_default")"
if [[ "$stray" != "0" ]]; then
  echo "$(ts) maintenance: WARNING: $stray rows in message_logs_default; partition creation fell behind" >&2
  [[ "${MAINT_STRICT:-0}" == "1" ]] && exit 3
fi
exit 0
