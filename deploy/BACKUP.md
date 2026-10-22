# Backups and recovery

Two layers protect the database. Run both in production.

## 1. Logical dumps (baseline, included)

`deploy/backup.sh` writes a compressed `pg_dump` custom-format dump plus a SHA-256 checksum,
and prunes dumps older than `RETENTION_DAYS` (default 14).

```bash
BACKUP_DIR=/srv/backups RETENTION_DAYS=30 deploy/backup.sh
```

Restore — by default into a throwaway `*_restore_check` database so you can prove a dump is good
without touching production:

```bash
deploy/restore.sh /srv/backups/sms_gateway_YYYYMMDDTHHMMSSZ.dump.gz
# real restore (destructive): TARGET_DB=sms_gateway FORCE=1 deploy/restore.sh <dump>
```

### Schedule it

Add to root's crontab (nightly at 02:30, keep 30 days, verify-restore weekly):

```cron
30 2 * * *  cd /root/sms-gateway && BACKUP_DIR=/srv/backups RETENTION_DAYS=30 deploy/backup.sh >> /var/log/smsgw-backup.log 2>&1
45 3 * * 0  cd /root/sms-gateway && deploy/restore.sh "$(ls -t /srv/backups/*.dump.gz | head -1)" >> /var/log/smsgw-restore-check.log 2>&1
```

Ship `/srv/backups` off the host (object storage, another server). A backup on the same disk as
the database is not a backup.

## 2. Continuous WAL archiving (point-in-time recovery)

Logical dumps lose everything written since the last dump. For a recovery point of seconds, enable
write-ahead-log archiving so you can replay to any moment. This runs on the Postgres server itself.

On the `postgres` service (`deploy/docker-compose.prod.yml`), set:

```
command:
  - "postgres"
  - "-c"
  - "wal_level=replica"
  - "-c"
  - "archive_mode=on"
  - "-c"
  - "archive_command=test ! -f /wal-archive/%f && cp %p /wal-archive/%f"
  - "-c"
  - "archive_timeout=300"          # force a segment at least every 5 minutes
```

Mount a durable, off-host-replicated volume at `/wal-archive`, then take a periodic base backup:

```bash
docker exec smsgw-postgres-1 pg_basebackup -U sms_owner -D - -Ft -z -Xf > base_$(date -u +%Y%m%dT%H%M%SZ).tar.gz
```

Recovery = restore the latest base backup, drop the archived WAL alongside it, and set
`recovery_target_time` to the desired moment. Rehearse this at least once before you need it.

Guard rail: the `message_logs_default` partition should stay empty and partitions should run 3
months ahead (`SELECT app.ensure_message_log_partitions();` daily, already wired in db-maint).
Backups do not fix a missing partition — monitor it (see `deploy/observability/`).
