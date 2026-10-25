# Operations

**Migrations.** `deploy/migrate.sh` applies `db/migrations/*.sql` in order. Each file and its
`schema_migrations` row commit in the same transaction, and a session advisory lock serializes
concurrent runners. It refuses to run if an applied file's checksum has changed: migrations are
append-only, so add `006_*.sql` instead of editing an old file. For a database built with
`db/reset-db.sh` (no tracking rows), run once with `MIGRATE_BASELINE=1`. A file marked
`-- migrate:no-transaction` runs outside a transaction, for `CREATE INDEX CONCURRENTLY`. The usual
upgrade is:

```bash
docker compose ... build && docker compose ... up -d
```

db-init applies new files before the engine and api start.

**Partitions.** `message_logs` is partitioned by month. `deploy/init/maintenance.sh` creates
partitions from last month through `MAINT_PARTITION_MONTHS` (default 3) ahead. If
`MESSAGE_LOG_RETENTION` (e.g. `13 months`) is set, it drops whole partitions older than that. It
warns when rows land in `message_logs_default`; treat that as an alert. In compose, `db-maint` runs
it every 6h. Without compose, add a cron line:

```cron
15 3 * * *  PGHOST=db PGUSER=sms_owner PGPASSWORD=... PGDATABASE=sms_gateway /opt/smsgw/deploy/init/maintenance.sh >>/var/log/smsgw-maint.log 2>&1
```

**Backups.**
- *Postgres:* take a nightly logical dump:

  ```bash
  docker compose ... exec -T postgres pg_dump -U sms_owner -Fc sms_gateway > sms_$(date +%F).dump
  ```

  Restore with `pg_restore -d <empty db> --no-owner`, then run db-init, which recreates the login
  roles. Roles are cluster-wide and are not in the dump. For point-in-time recovery, run WAL
  archiving (pgBackRest or wal-g) against the `pg_data` volume.
- *Redis* holds the live balances. The engine's syncer copies them to `accounts_balance` every
  ~2s, and Postgres is the system of record when a key is missing, because the engine re-hydrates.
  Still snapshot the AOF/RDB in `redis_data` (`BGSAVE`, then copy `/data`) so that in-flight
  debits, queued dispatch streams and DLR maps survive a host loss.
- *Secrets:* keep `APP_ENC_KEY` in a secret manager. A database backup is unreadable for the
  `*_enc` columns without it.

**Monitoring.**
- Scrape `engine:9100/metrics` from the `backend` network.
- Readiness checks: `GET /internal/v1/health` (with the token; 503 when DB or Redis is down) and
  `GET /api/health`.
- Alert on Redis `used_memory` against `maxmemory`: with `noeviction`, writes fail when it is full.
- Alert on rows in `message_logs_default`.
- Alert on engine `connections_up < connections_total` (also visible in `/api/analytics/live`).

**Scaling.**
- *api:* stateless, so scale it horizontally (`docker compose up -d --scale api=3`, but then drop
  the fixed host port and put nginx or a load balancer in front). The background workers can stay
  on in every replica: campaigns are claimed with `FOR UPDATE SKIP LOCKED`, alerts are deduplicated
  in Redis, and the ledger reconciler is idempotent.
- *engine:* several instances can share Postgres and Redis. Each takes a unique
  `ENGINE_INSTANCE_ID` (defaults to hostname-pid) as its Redis stream consumer. Balance syncs are
  guarded by `synced_at`, and dispatch uses consumer groups. Note:
  - Every instance binds every upstream connection's `sessions`, so divide those counts and TPS
    across instances or the upstream sees N× the binds.
  - Client SMPP sessions are per instance. Front them with a TCP load balancer. A client's binds
    may land on different instances: multipart parts are reassembled in Redis (`cc:*`), and
    delivery receipts are handed to the instance that holds the client's RX/TRX session (receiver
    registry `smpp:rx:<system_id>`, per-instance stream `q:dlr-out:i:<instance>`; the stream of an
    instance that stops heart-beating is moved back to `q:dlr-out` after ~2 minutes).
- *Redis:* must stay a single primary, not Redis Cluster, because the rate-limit script uses keys
  without a shared hash tag. Scale it vertically, and use Sentinel or a managed replica for
  failover.
- *Postgres:* size `PG_MAX_CONNECTIONS` for engine pools + 2 × api pools per replica. Monthly
  partitions keep `message_logs` indexes small. Put a read replica behind reporting if analytics
  load grows.
