#!/usr/bin/env bash
# Install / update the host domain-agent. Idempotent.
#
#   DOMAIN_AGENT_TOKEN=xxxxx sudo -E deploy/domain-agent/install.sh
#
# The token is written to /etc/domain-agent/env (0600) and NEVER printed. If the
# env file already has a token and none is supplied, the existing one is kept.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LIB=/usr/local/lib/domain-agent
ENVDIR=/etc/domain-agent
UNIT=/etc/systemd/system/domain-agent.service
SOCKDIR=/run/domainagent

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

install -d -m 0755 "$LIB" "$ENVDIR" "$SOCKDIR"
install -m 0755 "$HERE/agent.py" "$LIB/agent.py"
install -m 0644 "$HERE/domain-agent.service" "$UNIT"

# Env file: create on first install; append/replace the token only if one is given.
touch "$ENVDIR/env"; chmod 0600 "$ENVDIR/env"
if [ -n "${DOMAIN_AGENT_TOKEN:-}" ]; then
  tmp="$(mktemp)"; chmod 0600 "$tmp"
  grep -v '^DOMAIN_AGENT_TOKEN=' "$ENVDIR/env" > "$tmp" 2>/dev/null || true
  printf 'DOMAIN_AGENT_TOKEN=%s\n' "$DOMAIN_AGENT_TOKEN" >> "$tmp"
  mv "$tmp" "$ENVDIR/env"; chmod 0600 "$ENVDIR/env"
elif ! grep -q '^DOMAIN_AGENT_TOKEN=' "$ENVDIR/env"; then
  echo "ERROR: no DOMAIN_AGENT_TOKEN supplied and none already configured" >&2
  exit 1
fi

systemctl daemon-reload
systemctl enable domain-agent.service >/dev/null 2>&1 || true
systemctl restart domain-agent.service
sleep 1
systemctl is-active --quiet domain-agent.service && echo "domain-agent: active" || {
  echo "domain-agent failed to start; see: journalctl -u domain-agent -n 50" >&2; exit 1; }
test -S "$SOCKDIR/agent.sock" && echo "socket: $SOCKDIR/agent.sock ready"
