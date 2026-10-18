-- =============================================================================
-- 006_rls_hardening.sql — close two RLS gaps left by 003 (defence in depth)
--
-- 1. refresh_tokens had no RLS, and 003's `GRANT ... ON ALL TABLES` gave the
--    tenant role full access: with no app.org_id set, sms_api could read every
--    tenant's refresh-token rows. Auth flows use the privileged pool (CONTRACTS:
--    auth flows only); the tenant pool only revokes sessions of users it can see
--    (password reset / user disable). So for sms_api:
--      - RLS: a token row is visible iff its user is visible (users RLS +
--        app.can_see_org on the user's org).
--      - No INSERT / DELETE (tokens are minted and pruned by the privileged pool).
--      - SELECT on every column except token_hash.
--
-- 2. RLS on the partitioned parent message_logs applies only to queries made
--    through the parent. The monthly partitions (and message_logs_default) had
--    relrowsecurity = false, and the initial ones got sms_api grants from 003, so
--    `SELECT * FROM message_logs_2026_10` saw every tenant's CDRs. Postgres checks
--    privileges only on the table named in the query, so access through the
--    parent keeps working after revoking sms_api's grants on the partitions
--    themselves. Partitions are also given RLS with no policy (deny-all for any
--    non-BYPASSRLS, non-owner role) so a stray future grant still fails closed.
--    sms_engine (BYPASSRLS) keeps its partition grants.
-- =============================================================================

BEGIN;

-- 1. refresh_tokens ---------------------------------------------------------------
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON refresh_tokens
  USING (EXISTS (SELECT 1 FROM users u
                  WHERE u.id = refresh_tokens.user_id AND app.can_see_org(u.org_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM users u
                       WHERE u.id = refresh_tokens.user_id AND app.can_see_org(u.org_id)));

REVOKE ALL ON refresh_tokens FROM sms_api;
GRANT SELECT (id, user_id, family_id, replaced_by, impersonated_org_id, expires_at,
              revoked_at, revoked_reason, created_ip, user_agent, created_at)
  ON refresh_tokens TO sms_api;
GRANT UPDATE (revoked_at, revoked_reason) ON refresh_tokens TO sms_api;

-- 2. message_logs partitions -----------------------------------------------------
-- Locks a partition down for the tenant role. Idempotent.
CREATE OR REPLACE FUNCTION app.lock_message_log_partition(p_part regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_part);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sms_api') THEN
    EXECUTE format('REVOKE ALL ON %s FROM sms_api', p_part);
  END IF;
  EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', p_part);
END $$;

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
      PERFORM app.lock_message_log_partition(to_regclass(part));
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END $$;

-- Existing partitions, including message_logs_default.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT i.inhrelid::regclass AS part
             FROM pg_inherits i
            WHERE i.inhparent = 'message_logs'::regclass
  LOOP
    PERFORM app.lock_message_log_partition(r.part);
  END LOOP;
END $$;

-- Only the migration owner / maintenance job manages partitions.
REVOKE EXECUTE ON FUNCTION app.lock_message_log_partition(regclass) FROM PUBLIC, sms_api, sms_engine;
REVOKE EXECUTE ON FUNCTION app.ensure_message_log_partitions(date, integer) FROM PUBLIC, sms_api, sms_engine;
REVOKE EXECUTE ON FUNCTION app.drop_message_log_partitions(interval) FROM PUBLIC, sms_api, sms_engine;

COMMIT;
