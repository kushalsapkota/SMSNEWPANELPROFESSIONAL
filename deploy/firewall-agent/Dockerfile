# Privileged host-firewall agent: programs the `inet smsgw` nftables table in the HOST network
# namespace (compose sets network_mode: host + cap_add NET_ADMIN). Driven by the API over a Unix
# socket on a shared volume. Runs as a NON-root user — nft gets CAP_NET_ADMIN via a file
# capability, so the process itself needs no root. Build context is the repo root.
FROM alpine:3.20 AS deps
RUN apk add --no-cache python3 nftables iproute2 libcap

FROM deps
RUN addgroup -g 10001 fwagent \
 && adduser -S -u 10001 -G fwagent fwagent \
 # Let the (non-root) agent run nft with NET_ADMIN only (combined with the container's bounding set).
 && setcap 'cap_net_admin+eip' /usr/sbin/nft \
 # Dirs the agent owns; a fresh named volume inherits this ownership on first mount.
 && mkdir -p /run/fwagent /var/lib/fwagent \
 && chown -R fwagent:fwagent /run/fwagent /var/lib/fwagent

COPY deploy/firewall-agent/agent.py /app/agent.py

ENV FW_AGENT_SOCKET=/run/fwagent/agent.sock \
    FW_STATE_FILE=/var/lib/fwagent/state.json \
    FW_REVERT_SECONDS=60 \
    FW_PROTECTED_PORTS=2775,3775

USER fwagent
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD test -S /run/fwagent/agent.sock || exit 1
ENTRYPOINT ["python3", "-u", "/app/agent.py"]
