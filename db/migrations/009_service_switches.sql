-- =============================================================================
-- 009_service_switches.sql — global operator kill switches
--
-- A single-row table of global on/off switches an administrator flips from
-- the panel to stop services immediately:
--   all_enabled      master switch; false stops every channel and bind
--   http_api_enabled HTTP API ingress (public /v1 send)
--   smpp_enabled     SMPP binds + submits (live binds are also dropped)
--   bulk_enabled     bulk / batch sending (campaigns, multi-recipient)
--
-- The engine reads this in its config snapshot (store.loadSwitches) and
-- enforces it in policy.CheckSwitches / CheckBind; the api forces a config
-- reload on every change so a flip applies live with no restart. Default is
-- all-on, and a missing row is treated as all-on (fail open): a kill switch
-- must never cause an outage by its absence.
--
-- Admin-only (RLS mirrors upstream_connections): only SUPER_ADMIN via the
-- api may read or write it; the engine (BYPASSRLS) reads it on reload.
-- =============================================================================

BEGIN;

CREATE TABLE service_switches (
  id               boolean     PRIMARY KEY DEFAULT true,
  all_enabled      boolean     NOT NULL DEFAULT true,
  http_api_enabled boolean     NOT NULL DEFAULT true,
  smpp_enabled     boolean     NOT NULL DEFAULT true,
  bulk_enabled     boolean     NOT NULL DEFAULT true,
  note             text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT service_switches_singleton CHECK (id)
);

-- The one and only row.
INSERT INTO service_switches (id) VALUES (true);

-- Admin only (upstream_connections pattern). sms_engine has BYPASSRLS.
ALTER TABLE service_switches ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_only ON service_switches USING (app.is_admin()) WITH CHECK (app.is_admin());

-- 003's blanket GRANT ... ON ALL TABLES only covered tables that existed
-- then, so grant this new table explicitly (like 004_features.sql does).
GRANT SELECT, INSERT, UPDATE ON service_switches TO sms_api, sms_engine;

COMMIT;
