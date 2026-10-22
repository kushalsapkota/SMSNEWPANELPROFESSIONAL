# Observability

Prometheus, Alertmanager and Grafana for the SMS gateway engine metrics.

## Run

```bash
cd deploy
# GRAFANA_ADMIN_PASSWORD must be set in deploy/.env
docker compose -f docker-compose.prod.yml -f docker-compose.observability.yml --env-file .env up -d prometheus alertmanager grafana
```

- Grafana: http://127.0.0.1:3002 (dashboard "SMS Gateway" is auto-provisioned)
- Prometheus: reachable on the `monitoring` network; expose via SSH tunnel if needed
- Alertmanager: edit `alertmanager.yml` to add email/Slack/webhook before relying on alerts

## What is covered

Prometheus scrapes the engine's `/metrics` on `:9100` (backend network). Alert rules in
`alerts.yml` cover engine down, upstream connection down, CDR/dispatch backlog, CDR write errors,
config-reload failures, high reject ratio, failover spikes and refund spikes. Thresholds are
starting points — tune them to your traffic.

## Not yet included (add if you want them)

- **Postgres metrics** (connections, replication lag, table bloat, and the `message_logs_default`
  row count that must stay zero): add `quay.io/prometheuscommunity/postgres-exporter` on the `data`
  network and uncomment the `postgres` job in `prometheus.yml`.
- **Redis metrics** (memory, evictions, the balance keyspace): add `oliver006/redis_exporter` and
  uncomment the `redis` job.
- **API/worker metrics**: the NestJS api does not expose a `/metrics` endpoint yet. Low-balance and
  route-down alerting currently lives in the api alerts worker; a `/metrics` endpoint would let
  Prometheus own it too.
