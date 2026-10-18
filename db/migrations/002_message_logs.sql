-- =============================================================================
-- 002_message_logs.sql — partitioned CDR table, partition management, rollups
-- =============================================================================

BEGIN;

-- One row per logical message (all parts). Monthly RANGE partitions.
-- PK must include the partition key, hence (id, created_at).
CREATE TABLE message_logs (
  id                   uuid        NOT NULL DEFAULT app.uuid_generate_v7(),
  created_at           timestamptz NOT NULL DEFAULT now(),

  org_id               uuid        NOT NULL,   -- sending client (or reseller)
  reseller_id          uuid,                   -- denormalized for reseller reports / RLS
  route_id             uuid,
  connection_id        uuid,
  template_id          uuid,
  campaign_id          uuid,

  channel              msg_channel NOT NULL,
  client_msg_ref       text,                   -- client's own id (HTTP) / our id returned in submit_sm_resp

  source_addr          varchar(21),
  source_ton           smallint,
  source_npi           smallint,
  destination_addr     varchar(21) NOT NULL,
  dest_ton             smallint,
  dest_npi             smallint,
  country_iso          char(2),
  mccmnc               varchar(6),

  orig_text            text        NOT NULL,   -- exactly what the client sent
  sent_text            text,                   -- what went upstream (after templating)
  otp_extracted        boolean,                -- NULL = route not in template mode
  encoding             msg_encoding NOT NULL DEFAULT 'GSM7',
  parts                smallint    NOT NULL DEFAULT 1 CHECK (parts BETWEEN 1 AND 255),

  status               msg_status  NOT NULL DEFAULT 'ACCEPTED',
  smsc_msg_ids         text[]      NOT NULL DEFAULT '{}',   -- one per submitted part
  error_code           text,                   -- our / submit_sm_resp command_status
  dlr_stat             varchar(7),             -- DELIVRD, UNDELIV, EXPIRED, ...
  dlr_err              varchar(3),

  client_rate_micros   bigint,                 -- per segment
  client_cost_micros   bigint,                 -- rate * parts
  reseller_cost_micros bigint,
  route_cost_micros    bigint,                 -- what upstream charges us
  refunded             boolean     NOT NULL DEFAULT false,

  submitted_at         timestamptz,
  dlr_received_at      timestamptz,

  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX message_logs_org_idx      ON message_logs (org_id, created_at DESC);
CREATE INDEX message_logs_reseller_idx ON message_logs (reseller_id, created_at DESC);
CREATE INDEX message_logs_route_idx    ON message_logs (route_id, created_at DESC);
CREATE INDEX message_logs_dest_idx     ON message_logs (destination_addr, created_at DESC);
CREATE INDEX message_logs_client_ref   ON message_logs (org_id, client_msg_ref) WHERE client_msg_ref IS NOT NULL;
-- DLR fallback lookup when the Redis id map has expired.
CREATE INDEX message_logs_smsc_ids     ON message_logs USING gin (smsc_msg_ids);
-- Sweeper for messages stuck without a final state.
CREATE INDEX message_logs_pending      ON message_logs (created_at)
  WHERE status IN ('ACCEPTED', 'QUEUED', 'SUBMITTED');

-- Safety net only: rows landing here mean partition creation fell behind.
-- Alert on `SELECT count(*) FROM message_logs_default` > 0.
CREATE TABLE message_logs_default PARTITION OF message_logs DEFAULT;

-- Creates monthly partitions from p_from's month for p_months months.
-- Idempotent; run daily from cron / pg_cron.
CREATE OR REPLACE FUNCTION app.ensure_message_log_partitions(
  p_from   date    DEFAULT current_date,
  p_months integer DEFAULT 3
) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  m_start date;
  m_end   date;
  part    text;
  created integer := 0;
BEGIN
  FOR i IN 0 .. p_months - 1 LOOP
    m_start := (date_trunc('month', p_from) + make_interval(months => i))::date;
    m_end   := (m_start + interval '1 month')::date;
    part    := format('message_logs_%s', to_char(m_start, 'YYYY_MM'));

    IF to_regclass(part) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF message_logs FOR VALUES FROM (%L) TO (%L)',
        part, m_start::timestamptz, m_end::timestamptz);
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END $$;

-- Retention: drops whole monthly partitions that ended before now() - p_keep.
CREATE OR REPLACE FUNCTION app.drop_message_log_partitions(p_keep interval) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  r       record;
  dropped integer := 0;
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'message_logs'::regclass
       AND c.relname ~ '^message_logs_[0-9]{4}_[0-9]{2}$'
       AND (to_date(substring(c.relname FROM '[0-9]{4}_[0-9]{2}$'), 'YYYY_MM')
            + interval '1 month') < now() - p_keep
  LOOP
    EXECUTE format('DROP TABLE %I', r.relname);
    dropped := dropped + 1;
  END LOOP;
  RETURN dropped;
END $$;

-- Previous month too, so late DLR backfills / clock skew have a home.
SELECT app.ensure_message_log_partitions((current_date - interval '1 month')::date, 5);

-- -----------------------------------------------------------------------------
-- Hourly rollups for dashboards (upserted by the CDR worker, never scanned
-- from message_logs at request time).
-- -----------------------------------------------------------------------------

CREATE TABLE message_stats_hourly (
  bucket               timestamptz NOT NULL,                 -- date_trunc('hour', created_at)
  org_id               uuid        NOT NULL,
  reseller_id          uuid,
  route_id             uuid        NOT NULL,
  country_iso          char(2)     NOT NULL DEFAULT '--',

  messages             bigint      NOT NULL DEFAULT 0,
  parts                bigint      NOT NULL DEFAULT 0,
  submitted            bigint      NOT NULL DEFAULT 0,
  delivered            bigint      NOT NULL DEFAULT 0,
  undelivered          bigint      NOT NULL DEFAULT 0,
  failed               bigint      NOT NULL DEFAULT 0,
  rejected             bigint      NOT NULL DEFAULT 0,
  expired              bigint      NOT NULL DEFAULT 0,

  client_cost_micros   bigint      NOT NULL DEFAULT 0,       -- reseller revenue
  reseller_cost_micros bigint      NOT NULL DEFAULT 0,       -- admin revenue
  route_cost_micros    bigint      NOT NULL DEFAULT 0,       -- admin cost

  PRIMARY KEY (bucket, org_id, route_id, country_iso)
);

CREATE INDEX message_stats_reseller_idx ON message_stats_hourly (reseller_id, bucket DESC);
CREATE INDEX message_stats_route_idx    ON message_stats_hourly (route_id, bucket DESC);

COMMIT;
