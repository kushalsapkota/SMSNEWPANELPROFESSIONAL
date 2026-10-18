#!/usr/bin/env bash
# deploy/init/init-roles.sh: create or update the production LOGIN roles from the environment.
#
# The migrations create the two NOLOGIN group roles (003_rls.sql):
#   sms_api     subject to RLS: the api tenant pool
#   sms_engine  BYPASSRLS: the engine, plus the api's privileged pool (auth, background jobs)
# This script creates the login roles the services actually connect as, which are the production
# equivalent of db/dev-roles.sql:
#   $SMS_API_DB_USER     (default sms_api_login)     LOGIN, member of sms_api,     NOBYPASSRLS
#   $SMS_ENGINE_DB_USER  (default sms_engine_login)  LOGIN, member of sms_engine,  BYPASSRLS
# BYPASSRLS is a role attribute and is NOT inherited through membership, so the engine login role
# must carry it itself.
#
# You can run it more than once. Missing roles are created. Existing roles get their password and
# attributes reset to the values above, so re-running after changing a password in .env rotates it.
# Run it after deploy/migrate.sh, as a superuser: only a superuser can grant BYPASSRLS.
#
# Required env: SMS_API_DB_PASSWORD, SMS_ENGINE_DB_PASSWORD (at least 16 characters each)
# Optional env: SMS_API_DB_USER, SMS_ENGINE_DB_USER, SMS_DB_CONNECTION_LIMIT (per role, default -1)
#               INIT_REVOKE_PUBLIC_CONNECT=1 (default) revokes CONNECT on the database from PUBLIC
# Connection: MIGRATE_DATABASE_URL | DATABASE_URL | MIGRATE_AS_POSTGRES=1 + PGDATABASE | PG* vars.
#
# Passwords are passed to psql through the environment (\getenv), never on the command line.
set -euo pipefail

log() { echo "init-roles: $*" >&2; }
die() { log "ERROR: $*"; exit 1; }

export SMS_API_DB_USER="${SMS_API_DB_USER:-sms_api_login}"
export SMS_ENGINE_DB_USER="${SMS_ENGINE_DB_USER:-sms_engine_login}"
export SMS_DB_CONNECTION_LIMIT="${SMS_DB_CONNECTION_LIMIT:--1}"
revoke_public="${INIT_REVOKE_PUBLIC_CONNECT:-1}"

for v in SMS_API_DB_USER SMS_ENGINE_DB_USER; do
  [[ "${!v}" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "$v must be a lower-case identifier (got '${!v}')"
done
[[ "$SMS_API_DB_USER" != "$SMS_ENGINE_DB_USER" ]] || die "SMS_API_DB_USER and SMS_ENGINE_DB_USER must differ"
for v in SMS_API_DB_PASSWORD SMS_ENGINE_DB_PASSWORD; do
  pw="${!v:-}"
  [[ -n "$pw" ]] || die "$v is required (generate: openssl rand -hex 24)"
  ((${#pw} >= 16)) || die "$v must be at least 16 characters (generate: openssl rand -hex 24)"
done
unset pw
[[ "$SMS_DB_CONNECTION_LIMIT" =~ ^-?[0-9]+$ ]] || die "SMS_DB_CONNECTION_LIMIT must be an integer"

url="${MIGRATE_DATABASE_URL:-${DATABASE_URL:-}}"
if [[ -n "$url" ]]; then
  PSQL=(psql "$url")
elif [[ "${MIGRATE_AS_POSTGRES:-0}" == "1" ]]; then
  [[ -n "${PGDATABASE:-}" ]] || die "MIGRATE_AS_POSTGRES=1 needs PGDATABASE"
  # runuser resets most of the environment: forward the variables psql reads via \getenv.
  PSQL=(runuser -u postgres -- env
        "SMS_API_DB_USER=$SMS_API_DB_USER" "SMS_API_DB_PASSWORD=$SMS_API_DB_PASSWORD"
        "SMS_ENGINE_DB_USER=$SMS_ENGINE_DB_USER" "SMS_ENGINE_DB_PASSWORD=$SMS_ENGINE_DB_PASSWORD"
        "SMS_DB_CONNECTION_LIMIT=$SMS_DB_CONNECTION_LIMIT"
        psql -d "$PGDATABASE")
else
  PSQL=(psql)
fi
PSQL+=(-X -q -v ON_ERROR_STOP=1 --no-psqlrc -v "revoke_public=$revoke_public")

"${PSQL[@]}" <<'SQL'
SET client_min_messages = warning;
\getenv api_user SMS_API_DB_USER
\getenv api_pw SMS_API_DB_PASSWORD
\getenv engine_user SMS_ENGINE_DB_USER
\getenv engine_pw SMS_ENGINE_DB_PASSWORD
\getenv conn_limit SMS_DB_CONNECTION_LIMIT

SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super,
       EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sms_api')
         AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sms_engine') AS groups_exist \gset
\if :is_super
\else
  \echo 'init-roles: ERROR: must run as a superuser (BYPASSRLS can only be granted by one)'
  SELECT 1/0 AS must_be_superuser;
\endif
\if :groups_exist
\else
  \echo 'init-roles: ERROR: roles sms_api / sms_engine are missing: run deploy/migrate.sh first'
  SELECT 1/0 AS run_migrations_first;
\endif

BEGIN;
SELECT format('CREATE ROLE %I LOGIN', :'api_user')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'api_user') \gexec
SELECT format('CREATE ROLE %I LOGIN', :'engine_user')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'engine_user') \gexec

-- Attributes are always (re)set so a hand-edited role converges back to the intended shape.
SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT CONNECTION LIMIT %s PASSWORD %L',
              :'api_user', :'conn_limit', :'api_pw') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS INHERIT CONNECTION LIMIT %s PASSWORD %L',
              :'engine_user', :'conn_limit', :'engine_pw') \gexec

-- Exactly one group each: the api login must never inherit sms_engine.
SELECT format('GRANT sms_api TO %I', :'api_user') \gexec
SELECT format('GRANT sms_engine TO %I', :'engine_user') \gexec
SELECT format('REVOKE sms_engine FROM %I', :'api_user')
 WHERE pg_has_role(:'api_user', 'sms_engine', 'MEMBER') \gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO %I, %I', current_database(), :'api_user', :'engine_user') \gexec
\if :revoke_public
SELECT format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', current_database()) \gexec
\endif
COMMIT;

\echo 'init-roles: login roles ready'
SQL
log "api role: $SMS_API_DB_USER (sms_api, RLS), engine role: $SMS_ENGINE_DB_USER (sms_engine, BYPASSRLS)"
