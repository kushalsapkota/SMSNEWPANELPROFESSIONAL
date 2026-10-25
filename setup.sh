#!/usr/bin/env bash
# SMS gateway: one-shot installer for a fresh Linux server (Ubuntu/Debian; RHEL-family best effort).
#
# Installs Docker + Compose, nginx and certbot, generates deploy/.env with fresh secrets, builds and
# starts the stack (postgres, redis, engine, api, web, firewall-agent), seeds the SUPER_ADMIN, puts
# nginx in front (HTTPS via Let's Encrypt when a domain is given, plain HTTP on the IP otherwise)
# and installs the host domain-agent. Safe to re-run: existing .env, certs and data are kept.
#
#   unzip sms-panel.zip && cd sms-gateway
#   sudo ./setup.sh --domain panel.example.com --email you@example.com
#
# Options (each also settable as an env var of the same name in CAPS):
#   --domain D          panel/API/SMPP hostname (DNS A record must already point here). Omit for IP-only HTTP.
#   --email E           Let's Encrypt account email (default: admin email)
#   --admin-email E     SUPER_ADMIN login (default: admin@<domain> or admin@localhost)
#   --admin-password P  SUPER_ADMIN password (default: random, saved to /root/SMS-PANEL-CREDENTIALS.txt)
#   --dir PATH          install location (default: /opt/sms-gateway; files are copied there)
#   --env FILE          reuse an existing deploy/.env (needed when migrating: APP_ENC_KEY must match)
#   --restore DUMP      restore a Postgres dump (.dump or .dump.gz, pg_dump -Fc) into the new stack
#   --no-nginx          skip nginx/certbot (you run your own proxy)
#   --no-firewall       don't start the firewall-agent container
#   --no-domain-agent   don't install the host domain-agent (panel Domains page)
#   --sim               also start the fake upstream SMSC (testing only)
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAIN="${DOMAIN:-}"; EMAIL="${EMAIL:-}"; ADMIN_EMAIL="${ADMIN_EMAIL:-}"; ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
DIR="${DIR:-/opt/sms-gateway}"; ENV_IN="${ENV_IN:-}"; RESTORE="${RESTORE:-}"
NGINX=1; FIREWALL=1; DOMAIN_AGENT=1; SIM=0

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="$2"; shift 2 ;;
    --admin-password) ADMIN_PASSWORD="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    --env) ENV_IN="$2"; shift 2 ;;
    --restore) RESTORE="$2"; shift 2 ;;
    --no-nginx) NGINX=0; shift ;;
    --no-firewall) FIREWALL=0; shift ;;
    --no-domain-agent) DOMAIN_AGENT=0; shift ;;
    --sim) SIM=1; shift ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

log()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWARN: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root (sudo ./setup.sh ...)"
[ -z "$ENV_IN" ] || [ -f "$ENV_IN" ] || die "--env file not found: $ENV_IN"
[ -z "$RESTORE" ] || [ -f "$RESTORE" ] || die "--restore dump not found: $RESTORE"
[ -n "$ENV_IN" ] && ENV_IN="$(readlink -f "$ENV_IN")"
[ -n "$RESTORE" ] && RESTORE="$(readlink -f "$RESTORE")"
[ -n "$ADMIN_EMAIL" ] || ADMIN_EMAIL="admin@${DOMAIN:-localhost}"
[ -n "$EMAIL" ] || EMAIL="$ADMIN_EMAIL"

# ---------------------------------------------------------------------------------------------
log "Installing system packages"
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl openssl python3 rsync gzip >/dev/null
  [ "$NGINX" = 1 ] && apt-get install -y -qq nginx certbot >/dev/null
elif command -v dnf >/dev/null || command -v yum >/dev/null; then
  PM="$(command -v dnf || command -v yum)"
  "$PM" install -y -q epel-release >/dev/null 2>&1 || true
  "$PM" install -y -q ca-certificates curl openssl python3 rsync gzip
  [ "$NGINX" = 1 ] && "$PM" install -y -q nginx certbot
else
  die "unsupported distro: need apt, dnf or yum"
fi

if ! command -v docker >/dev/null; then
  log "Installing Docker (get.docker.com)"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || {
  command -v apt-get >/dev/null && apt-get install -y -qq docker-compose-plugin >/dev/null 2>&1 || true
  docker compose version >/dev/null 2>&1 || die "docker compose plugin missing; install docker-compose-plugin"
}

# ---------------------------------------------------------------------------------------------
if [ "$SRC" != "$(readlink -f "$DIR" 2>/dev/null || echo "$DIR")" ]; then
  log "Copying project to $DIR"
  mkdir -p "$DIR"
  rsync -a --exclude node_modules --exclude .next --exclude dist --exclude 'deploy/.run' \
    --exclude 'deploy/.env' "$SRC"/ "$DIR"/
fi
cd "$DIR"
chmod +x deploy/*.sh deploy/init/*.sh deploy/domain-agent/install.sh 2>/dev/null || true

# ---------------------------------------------------------------------------------------------
ENVF=deploy/.env
setkv() {  # setkv KEY VALUE: replace (or append) KEY=VALUE in deploy/.env
  local k="$1" v="$2" tmp; tmp="$(mktemp)"
  grep -v "^${k}=" "$ENVF" > "$tmp" || true
  printf '%s=%s\n' "$k" "$v" >> "$tmp"
  cat "$tmp" > "$ENVF"; rm -f "$tmp"
}
getkv() {  # getkv KEY [DEFAULT]
  local v; v="$( { grep -E "^$1=" "$ENVF" || true; } | tail -1 | cut -d= -f2-)"
  printf '%s' "${v:-${2:-}}"
}
fill()  { [ -n "$(getkv "$1")" ] || setkv "$1" "$2"; }   # only set when empty/missing

if [ -n "$ENV_IN" ]; then
  log "Using existing env file $ENV_IN"
  install -m 600 "$ENV_IN" "$ENVF"
elif [ ! -f "$ENVF" ]; then
  log "Generating $ENVF with fresh secrets"
  install -m 600 deploy/.env.example "$ENVF"
else
  log "Keeping existing $ENVF"
fi
chmod 600 "$ENVF"
fill POSTGRES_PASSWORD      "$(openssl rand -hex 24)"
fill SMS_API_DB_PASSWORD    "$(openssl rand -hex 24)"
fill SMS_ENGINE_DB_PASSWORD "$(openssl rand -hex 24)"
fill REDIS_PASSWORD         "$(openssl rand -hex 24)"
fill INTERNAL_TOKEN         "$(openssl rand -hex 32)"
fill APP_ENC_KEY            "$(openssl rand -base64 32)"
fill JWT_SECRET             "$(openssl rand -hex 48)"
[ "$FIREWALL" = 1 ]     && fill FW_AGENT_TOKEN     "$(openssl rand -hex 32)"
[ "$DOMAIN_AGENT" = 1 ] && fill DOMAIN_AGENT_TOKEN "$(openssl rand -hex 32)"
if [ -n "$DOMAIN" ]; then
  setkv PUBLIC_SMPP_HOST "$DOMAIN"
  setkv PUBLIC_API_BASE_URL "https://$DOMAIN"
fi
# Never store the admin password in .env (seed reads it from the command line).
setkv ADMIN_PASSWORD ""

# Size Postgres to the machine (~25% / 75% of RAM).
mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ -z "$ENV_IN" ] && [ "$mem_mb" -gt 0 ]; then
  setkv PG_SHARED_BUFFERS "$(( mem_mb / 4 ))MB"
  setkv PG_EFFECTIVE_CACHE_SIZE "$(( mem_mb * 3 / 4 ))MB"
fi

# ---------------------------------------------------------------------------------------------
# The api bind-mounts /run/domainagent, so the agent goes in before the stack starts.
if [ "$DOMAIN_AGENT" = 1 ] && [ "$NGINX" = 1 ]; then
  log "Installing host domain-agent"
  mkdir -p /var/www/certbot /etc/nginx/sites-available /etc/nginx/sites-enabled
  DOMAIN_AGENT_TOKEN="$(getkv DOMAIN_AGENT_TOKEN)" bash deploy/domain-agent/install.sh \
    || warn "domain-agent did not start (panel Domains page will show 'not deployed')"
else
  mkdir -p /run/domainagent
fi

wait_healthy() {  # wait until engine, api and web report healthy
  local i s
  for i in $(seq 1 90); do
    s="$(docker inspect -f '{{.State.Health.Status}}' smsgw-engine-1 smsgw-api-1 smsgw-web-1 2>/dev/null | sort -u | tr '\n' ' ')"
    [ "$s" = "healthy " ] && return 0
    sleep 5
  done
  "${COMPOSE[@]}" ps; die "stack did not become healthy; check: ${COMPOSE[*]} logs --tail 100"
}

COMPOSE=(docker compose -f deploy/docker-compose.prod.yml --env-file "$ENVF")
PROFILES=()
[ "$FIREWALL" = 1 ] && PROFILES+=(--profile firewall)
[ "$SIM" = 1 ] && PROFILES+=(--profile sim)

log "Building images (first run takes several minutes)"
"${COMPOSE[@]}" "${PROFILES[@]}" build

log "Starting the stack"
"${COMPOSE[@]}" "${PROFILES[@]}" up -d
wait_healthy

# ---------------------------------------------------------------------------------------------
if [ -n "$RESTORE" ]; then
  log "Restoring database from $RESTORE"
  db="$(getkv POSTGRES_DB sms_gateway)"
  owner="$(getkv POSTGRES_USER sms_owner)"
  "${COMPOSE[@]}" stop engine api web
  pg() { docker exec -i smsgw-postgres-1 psql -v ON_ERROR_STOP=1 -U "$owner" -d postgres "$@"; }
  pg -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)"
  pg -c "CREATE DATABASE \"$db\""
  case "$RESTORE" in *.gz) reader=(gzip -dc "$RESTORE") ;; *) reader=(cat "$RESTORE") ;; esac
  # Keep privileges (the RLS grants to sms_api / sms_engine live in the dump when it was taken
  # without --no-privileges); ownership collapses onto the new owner role.
  "${reader[@]}" | docker exec -i smsgw-postgres-1 pg_restore --no-owner -U "$owner" -d "$db" \
    || warn "pg_restore reported errors (often harmless, e.g. existing extensions); review above"
  # db-init re-applies login roles, CONNECT grants and any newer migrations.
  "${COMPOSE[@]}" "${PROFILES[@]}" up -d --force-recreate db-init engine api web
  wait_healthy
fi

# ---------------------------------------------------------------------------------------------
CRED=/root/SMS-PANEL-CREDENTIALS.txt
if [ -z "$RESTORE" ]; then
  gen_pw=0
  if [ -z "$ADMIN_PASSWORD" ]; then ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=')"; gen_pw=1; fi
  log "Seeding SUPER_ADMIN $ADMIN_EMAIL"
  ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    "${COMPOSE[@]}" --profile seed run --rm -e ADMIN_EMAIL -e ADMIN_PASSWORD seed
  if [ "$gen_pw" = 1 ]; then
    umask 077
    printf 'SMS panel admin\nURL:      %s\nEmail:    %s\nPassword: %s\n' \
      "${DOMAIN:+https://$DOMAIN}${DOMAIN:-http://<server-ip>}" "$ADMIN_EMAIL" "$ADMIN_PASSWORD" > "$CRED"
  fi
fi

# ---------------------------------------------------------------------------------------------
if [ "$NGINX" = 1 ]; then
  log "Configuring nginx"
  mkdir -p /var/www/certbot /etc/nginx/sites-available /etc/nginx/sites-enabled
  if [ -d /etc/nginx/conf.d ] && ! grep -q 'sites-enabled' /etc/nginx/nginx.conf; then
    # RHEL-family nginx has no sites-enabled include.
    sed -i 's|^\(\s*\)include /etc/nginx/conf.d/\*.conf;|&\n\1include /etc/nginx/sites-enabled/*;|' /etc/nginx/nginx.conf
  fi
  rm -f /etc/nginx/sites-enabled/default
  SITE=/etc/nginx/sites-available/smsgw

  if [ -n "$DOMAIN" ]; then
    if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
      # Temporary HTTP-only vhost so certbot's webroot challenge can be served.
      cat > "$SITE" <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    location ^~ /.well-known/acme-challenge/ { root /var/www/certbot; default_type "text/plain"; }
    location / { return 404; }
}
EOF
      ln -sf "$SITE" /etc/nginx/sites-enabled/smsgw
      nginx -t && systemctl enable --now nginx && systemctl reload nginx
      log "Requesting Let's Encrypt certificate for $DOMAIN"
      certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" \
        --email "$EMAIL" --agree-tos --no-eff-email --non-interactive \
        || die "certbot failed: check that $DOMAIN resolves to this server and port 80 is open"
    fi
    sed "s/nepalotp\.duckdns\.org/$DOMAIN/g" deploy/nginx-duckdns.conf > "$SITE"
    # certbot's nginx plugin files may be absent (certonly/webroot); use inline TLS settings then.
    if [ ! -f /etc/letsencrypt/options-ssl-nginx.conf ] || [ ! -f /etc/letsencrypt/ssl-dhparams.pem ]; then
      sed -i -e '/options-ssl-nginx.conf/c\    ssl_protocols TLSv1.2 TLSv1.3; ssl_prefer_server_ciphers off; ssl_session_cache shared:SSL:10m; ssl_session_timeout 1d;' \
             -e '/ssl-dhparams.pem/d' "$SITE"
    fi
    # Reload nginx after every renewal.
    mkdir -p /etc/letsencrypt/renewal-hooks/deploy
    printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
    chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
    systemctl enable --now certbot.timer >/dev/null 2>&1 || true
  else
    cp deploy/nginx-http-ip.conf "$SITE"
  fi
  ln -sf "$SITE" /etc/nginx/sites-enabled/smsgw
  nginx -t || die "nginx config test failed ($SITE)"
  systemctl enable --now nginx >/dev/null 2>&1; systemctl reload nginx
fi

# ---------------------------------------------------------------------------------------------
if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  log "Opening ports in ufw"
  for p in 22/tcp 80/tcp 443/tcp "$(getkv SMPP_PUBLIC_PORT 2775)/tcp"; do ufw allow "$p" >/dev/null; done
elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  log "Opening ports in firewalld"
  for p in 80/tcp 443/tcp 2775/tcp; do firewall-cmd -q --permanent --add-port="$p"; done
  firewall-cmd -q --reload
fi

# ---------------------------------------------------------------------------------------------
ip="$(curl -4fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
log "Done"
"${COMPOSE[@]}" ps --format 'table {{.Name}}\t{{.Status}}'
cat <<EOF

  Panel:      ${DOMAIN:+https://$DOMAIN}${DOMAIN:-http://$ip}
  HTTP API:   ${DOMAIN:+https://$DOMAIN}${DOMAIN:-http://$ip}/v1/
  SMPP:       ${DOMAIN:-$ip}:$(getkv SMPP_PUBLIC_PORT 2775)
  Install:    $DIR   (secrets in $DIR/$ENVF — back up APP_ENC_KEY!)
EOF
[ -f "$CRED" ] && [ -z "$RESTORE" ] && echo "  Admin login saved to $CRED"
[ -n "$RESTORE" ] && echo "  Database restored: log in with your existing accounts."
cat <<EOF

  Manage:     cd $DIR && docker compose -f deploy/docker-compose.prod.yml --env-file $ENVF ps|logs|restart
  Backups:    $DIR/deploy/backup.sh   (add to cron)
EOF
