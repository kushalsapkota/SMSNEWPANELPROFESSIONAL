-- =============================================================================
-- 003_rls.sql — row-level tenant isolation
--
-- Two DB roles:
--   sms_api     NestJS API. Subject to RLS. Before each request-scoped
--               transaction the API runs:
--                 SELECT set_config('app.org_id', '<org uuid>', true),
--                        set_config('app.role',   '<SUPER_ADMIN|RESELLER|CLIENT>', true);
--               (When impersonating, app.org_id is the impersonated client.)
--   sms_engine  Go SMPP engine / workers. BYPASSRLS — it is tenant-agnostic.
--
-- RLS here is tenant *isolation* (who can see which rows), not authorization
-- (e.g. a client may not edit its own balance) — that lives in the API.
-- With no app.org_id set, nothing is visible: fail closed.
-- =============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sms_api') THEN
    CREATE ROLE sms_api NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sms_engine') THEN
    CREATE ROLE sms_engine NOLOGIN BYPASSRLS;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app.current_org_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.org_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.is_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.role', true) = 'SUPER_ADMIN', false)
$$;

-- Self, or a direct child (reseller -> its clients), or anything for admin.
-- SECURITY DEFINER so the lookup on organizations is not itself filtered by RLS.
CREATE OR REPLACE FUNCTION app.can_see_org(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app.is_admin()
      OR target = app.current_org_id()
      OR EXISTS (SELECT 1 FROM organizations
                  WHERE id = target AND parent_id = app.current_org_id())
$$;

-- Tables keyed by org_id.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'accounts_balance', 'balance_transactions', 'org_route_assignments',
    'sender_ids', 'api_keys', 'smpp_accounts', 'ip_whitelists', 'webhooks'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (app.can_see_org(org_id)) WITH CHECK (app.can_see_org(org_id))',
      t);
  END LOOP;
END $$;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organizations
  USING (app.can_see_org(id))
  WITH CHECK (app.can_see_org(id) OR app.can_see_org(parent_id));

-- Route-wide templates (org_id NULL) are readable by anyone who can see the
-- route assignment; only admins may write them.
ALTER TABLE route_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON route_templates FOR SELECT
  USING (org_id IS NULL OR app.can_see_org(org_id));
CREATE POLICY tenant_write ON route_templates FOR ALL
  USING (app.is_admin() OR (org_id IS NOT NULL AND app.can_see_org(org_id)))
  WITH CHECK (app.is_admin() OR (org_id IS NOT NULL AND app.can_see_org(org_id)));

-- Big tables: use the denormalized reseller_id instead of a per-row subquery.
ALTER TABLE message_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON message_logs
  USING (app.is_admin() OR org_id = app.current_org_id() OR reseller_id = app.current_org_id());

ALTER TABLE message_stats_hourly ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON message_stats_hourly
  USING (app.is_admin() OR org_id = app.current_org_id() OR reseller_id = app.current_org_id());

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON audit_logs FOR SELECT
  USING (app.is_admin() OR app.can_see_org(target_org_id) OR actor_org_id = app.current_org_id());
CREATE POLICY tenant_insert ON audit_logs FOR INSERT
  WITH CHECK (app.is_admin() OR actor_org_id = app.current_org_id());

-- Upstream credentials and route internals: admin only.
ALTER TABLE upstream_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_only ON upstream_connections USING (app.is_admin()) WITH CHECK (app.is_admin());
ALTER TABLE upstream_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_only ON upstream_rates USING (app.is_admin()) WITH CHECK (app.is_admin());
ALTER TABLE route_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_only ON route_connections USING (app.is_admin()) WITH CHECK (app.is_admin());

-- Routes: readable when assigned to you (or a client of yours); admin writes.
ALTER TABLE routes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON routes FOR SELECT
  USING (app.is_admin() OR EXISTS (SELECT 1 FROM org_route_assignments a
                                    WHERE a.route_id = routes.id AND app.can_see_org(a.org_id)));
CREATE POLICY admin_write ON routes FOR ALL USING (app.is_admin()) WITH CHECK (app.is_admin());

-- Grants
GRANT USAGE ON SCHEMA public, app TO sms_api, sms_engine;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO sms_api, sms_engine;
GRANT SELECT ON app.org_effective_state TO sms_api, sms_engine;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sms_api, sms_engine;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO sms_api, sms_engine;

-- Nobody rewrites history.
REVOKE UPDATE, DELETE ON audit_logs FROM sms_api, sms_engine;

-- Partitions created later by app.ensure_message_log_partitions inherit
-- policies from the parent; grants on the parent cover access through it.

COMMIT;
