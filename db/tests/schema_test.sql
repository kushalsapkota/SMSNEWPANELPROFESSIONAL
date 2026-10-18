-- Run against a freshly migrated DB as a superuser:
--   psql -v ON_ERROR_STOP=1 -d <db> < db/tests/schema_test.sql
-- Everything runs in one transaction and is rolled back.

\set QUIET on
BEGIN;

CREATE FUNCTION pg_temp.expect_error(sql text, needle text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE sql;
  EXCEPTION WHEN OTHERS THEN
    IF position(needle IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'expected error containing "%", got: %', needle, SQLERRM;
    END IF;
    RAISE NOTICE 'ok - rejects: %', left(sql, 90);
    RETURN;
  END;
  RAISE EXCEPTION 'expected error containing "%" but statement succeeded: %', needle, sql;
END $$;

CREATE FUNCTION pg_temp.ok(cond boolean, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAILED: %', label; END IF;
  RAISE NOTICE 'ok - %', label;
END $$;

-- Fixtures: admin -> r1 -> c1, admin -> r2 -> c2 -------------------------------
INSERT INTO organizations (id, role, parent_id, name) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'SUPER_ADMIN', NULL,                                   'Admin'),
  ('00000000-0000-0000-0000-0000000000b1', 'RESELLER',    '00000000-0000-0000-0000-0000000000a1', 'Reseller 1'),
  ('00000000-0000-0000-0000-0000000000b2', 'RESELLER',    '00000000-0000-0000-0000-0000000000a1', 'Reseller 2'),
  ('00000000-0000-0000-0000-0000000000c1', 'CLIENT',      '00000000-0000-0000-0000-0000000000b1', 'Client 1'),
  ('00000000-0000-0000-0000-0000000000c2', 'CLIENT',      '00000000-0000-0000-0000-0000000000b2', 'Client 2');

INSERT INTO upstream_connections (id, name, host, port, system_id, password_enc, max_tps)
VALUES ('00000000-0000-0000-0000-0000000000e1', 'carrier-a', 'smpp.example.net', 2775, 'acme', 'enc:xxx', 100);

INSERT INTO routes (id, name, template_mode) VALUES
  ('00000000-0000-0000-0000-0000000000d1', 'OTP-Premium', true),
  ('00000000-0000-0000-0000-0000000000d2', 'Bulk-Promo',  false);

INSERT INTO route_connections (route_id, connection_id)
VALUES ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1');

-- 1. Hierarchy ---------------------------------------------------------------
SELECT pg_temp.expect_error(
  $$INSERT INTO organizations (role, parent_id, name) VALUES ('CLIENT', '00000000-0000-0000-0000-0000000000a1', 'x')$$,
  'CLIENT must belong to a RESELLER');
SELECT pg_temp.expect_error(
  $$INSERT INTO organizations (role, parent_id, name) VALUES ('RESELLER', '00000000-0000-0000-0000-0000000000b1', 'x')$$,
  'RESELLER must belong to a SUPER_ADMIN');
SELECT pg_temp.expect_error(
  $$INSERT INTO organizations (role, parent_id, name) VALUES ('RESELLER', NULL, 'x')$$,
  'RESELLER must belong to a SUPER_ADMIN');
SELECT pg_temp.expect_error(
  $$INSERT INTO organizations (role, parent_id, name) VALUES ('SUPER_ADMIN', '00000000-0000-0000-0000-0000000000a1', 'x')$$,
  'org_root_has_no_parent');
SELECT pg_temp.expect_error(
  $$UPDATE organizations SET role = 'RESELLER' WHERE id = '00000000-0000-0000-0000-0000000000c1'$$,
  'immutable');
SELECT pg_temp.expect_error(
  $$UPDATE organizations SET parent_id = '00000000-0000-0000-0000-0000000000a1' WHERE id = '00000000-0000-0000-0000-0000000000c1'$$,
  'CLIENT must belong to a RESELLER');

-- 2. Route assignment chain ----------------------------------------------------
SELECT pg_temp.expect_error(
  $$INSERT INTO org_route_assignments (org_id, route_id, rate_micros)
    VALUES ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1', 5000)$$,
  'is not assigned to reseller');

INSERT INTO org_route_assignments (org_id, route_id, rate_micros, prefix) VALUES
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000d1', 3000, ''),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000d1', 2500, '91');
INSERT INTO org_route_assignments (org_id, route_id, rate_micros)
  VALUES ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1', 5000);
SELECT pg_temp.ok(true, 'client gets route once reseller has it');

SELECT pg_temp.expect_error(
  $$INSERT INTO org_route_assignments (org_id, route_id, rate_micros)
    VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', 1)$$,
  'not assigned to SUPER_ADMIN');

-- Removing one of two reseller prefixes keeps the client's route...
DELETE FROM org_route_assignments
 WHERE org_id = '00000000-0000-0000-0000-0000000000b1' AND prefix = '91';
SELECT pg_temp.ok(
  (SELECT enabled FROM org_route_assignments WHERE org_id = '00000000-0000-0000-0000-0000000000c1'),
  'client keeps route while reseller still has it under another prefix');
-- ...removing the last one cascades.
DELETE FROM org_route_assignments WHERE org_id = '00000000-0000-0000-0000-0000000000b1';
SELECT pg_temp.ok(
  NOT (SELECT enabled FROM org_route_assignments WHERE org_id = '00000000-0000-0000-0000-0000000000c1'),
  'unassigning reseller route disables it for its clients');
SELECT pg_temp.expect_error(
  $$UPDATE org_route_assignments SET enabled = true WHERE org_id = '00000000-0000-0000-0000-0000000000c1'$$,
  'is not assigned to reseller');

-- Restore for later tests.
INSERT INTO org_route_assignments (org_id, route_id, rate_micros)
  VALUES ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000d1', 3000);
UPDATE org_route_assignments SET enabled = true WHERE org_id = '00000000-0000-0000-0000-0000000000c1';

-- 3. Templates -----------------------------------------------------------------
SELECT pg_temp.expect_error(
  $$INSERT INTO route_templates (route_id, name, template_body)
    VALUES ('00000000-0000-0000-0000-0000000000d1', 'bad', 'No placeholder here')$$,
  'route_templates_template_body_check');

INSERT INTO route_templates (route_id, name, template_body)
VALUES ('00000000-0000-0000-0000-0000000000d1', 'default',
        'Your verification code is {otp}. Valid for 10 minutes. -{brand}');

SELECT pg_temp.expect_error(
  $$INSERT INTO route_templates (route_id, name, template_body)
    VALUES ('00000000-0000-0000-0000-0000000000d1', 'second', 'Code {otp}')$$,
  'route_templates_one_active');

INSERT INTO route_templates (route_id, org_id, name, template_body)
VALUES ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1',
        'client override', '{otp} is your Client1 login code');
SELECT pg_temp.ok(true, 'per-client override coexists with route default');

SELECT pg_temp.expect_error(
  $$INSERT INTO route_templates (route_id, name, template_body, fallback_action, is_active)
    VALUES ('00000000-0000-0000-0000-0000000000d1', 'x', 'Code {otp}', 'SEND_DEFAULT_TEMPLATE', false)$$,
  'route_templates_check');

-- 4. Effective state ------------------------------------------------------------
SELECT pg_temp.ok(
  (SELECT can_send AND can_api AND NOT can_smpp FROM app.org_effective_state
    WHERE id = '00000000-0000-0000-0000-0000000000c1'),
  'fresh client can send via API, SMPP off by default');

UPDATE organizations SET sending_enabled = false WHERE id = '00000000-0000-0000-0000-0000000000c1';
SELECT pg_temp.ok(
  (SELECT is_active AND NOT can_send AND NOT can_api FROM app.org_effective_state
    WHERE id = '00000000-0000-0000-0000-0000000000c1'),
  'stop-sending keeps login but blocks traffic');
UPDATE organizations SET sending_enabled = true WHERE id = '00000000-0000-0000-0000-0000000000c1';

UPDATE organizations SET status = 'SUSPENDED' WHERE id = '00000000-0000-0000-0000-0000000000b1';
SELECT pg_temp.ok(
  (SELECT NOT is_active AND NOT can_send FROM app.org_effective_state
    WHERE id = '00000000-0000-0000-0000-0000000000c1'),
  'suspending reseller blocks its clients');
SELECT pg_temp.ok(
  (SELECT can_send FROM app.org_effective_state WHERE id = '00000000-0000-0000-0000-0000000000c2'),
  'other reseller''s clients unaffected');
UPDATE organizations SET status = 'ACTIVE' WHERE id = '00000000-0000-0000-0000-0000000000b1';

UPDATE organizations SET max_tps = 50 WHERE id = '00000000-0000-0000-0000-0000000000b1';
UPDATE organizations SET max_tps = 200 WHERE id = '00000000-0000-0000-0000-0000000000c1';
SELECT pg_temp.ok(
  (SELECT effective_max_tps = 50 FROM app.org_effective_state WHERE id = '00000000-0000-0000-0000-0000000000c1'),
  'client TPS capped by reseller TPS');

-- 5. IP whitelist -----------------------------------------------------------------
SELECT pg_temp.ok(app.ip_allowed('00000000-0000-0000-0000-0000000000c1', '8.8.8.8', 'API'),
  'no whitelist rows = open');
INSERT INTO ip_whitelists (org_id, cidr, scope) VALUES ('00000000-0000-0000-0000-0000000000c1', '10.0.0.0/24', 'API');
SELECT pg_temp.ok(app.ip_allowed('00000000-0000-0000-0000-0000000000c1', '10.0.0.5', 'API'), 'IP inside CIDR allowed');
SELECT pg_temp.ok(NOT app.ip_allowed('00000000-0000-0000-0000-0000000000c1', '10.0.1.5', 'API'), 'IP outside CIDR blocked');
SELECT pg_temp.ok(app.ip_allowed('00000000-0000-0000-0000-0000000000c1', '10.0.1.5', 'SMPP'), 'API whitelist does not affect SMPP');
INSERT INTO ip_whitelists (org_id, cidr, scope) VALUES ('00000000-0000-0000-0000-0000000000c1', '192.168.1.10/32', 'ALL');
SELECT pg_temp.ok(NOT app.ip_allowed('00000000-0000-0000-0000-0000000000c1', '10.0.1.5', 'SMPP'), 'ALL scope applies to SMPP');
SELECT pg_temp.ok(app.ip_allowed('00000000-0000-0000-0000-0000000000c1', '192.168.1.10', 'API'), 'ALL scope applies to API');

-- 6. Misc constraints --------------------------------------------------------------
SELECT pg_temp.expect_error(
  $$INSERT INTO sender_ids (org_id, sender) VALUES ('00000000-0000-0000-0000-0000000000c1', 'WAYTOOLONGSENDER')$$,
  'sender_ids_sender_check');
INSERT INTO sender_ids (org_id, sender) VALUES ('00000000-0000-0000-0000-0000000000c1', 'MYBANK'),
                                              ('00000000-0000-0000-0000-0000000000c1', '+447700900123');
SELECT pg_temp.expect_error(
  $$INSERT INTO sender_ids (org_id, sender) VALUES ('00000000-0000-0000-0000-0000000000c1', 'MYBANK')$$,
  'sender_ids_unique');

SELECT pg_temp.expect_error(
  $$INSERT INTO accounts_balance (org_id, billing_mode, credit_limit_micros)
    VALUES ('00000000-0000-0000-0000-0000000000c1', 'PREPAID', 1000)$$,
  'prepaid_has_no_credit');
INSERT INTO accounts_balance (org_id, billing_mode, credit_limit_micros)
  VALUES ('00000000-0000-0000-0000-0000000000c1', 'POSTPAID', 1000);

INSERT INTO audit_logs (actor_org_id, action) VALUES ('00000000-0000-0000-0000-0000000000b1', 'client.suspend');
SELECT pg_temp.expect_error($$UPDATE audit_logs SET action = 'x'$$, 'append-only');
SELECT pg_temp.expect_error($$DELETE FROM audit_logs$$, 'append-only');

SELECT pg_temp.ok(substr(app.uuid_generate_v7()::text, 15, 1) = '7', 'uuid_generate_v7 yields version 7');

-- 7. Partitions ----------------------------------------------------------------------
INSERT INTO message_logs (org_id, reseller_id, route_id, channel, destination_addr, orig_text, sent_text, otp_extracted)
VALUES ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1',
        '00000000-0000-0000-0000-0000000000d1', 'HTTP', '919876543210',
        'Ur code 849201 is valid for login',
        'Your verification code is 849201. Valid for 10 minutes. -Acme', true),
       ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000b2',
        '00000000-0000-0000-0000-0000000000d2', 'SMPP', '447700900123', 'promo', 'promo', NULL);

SELECT pg_temp.ok(
  (SELECT tableoid::regclass::text FROM message_logs WHERE org_id = '00000000-0000-0000-0000-0000000000c1')
    = 'message_logs_' || to_char(now(), 'YYYY_MM'),
  'current message lands in its monthly partition');

INSERT INTO message_logs (created_at, org_id, channel, destination_addr, orig_text)
VALUES (now() + interval '3 years', '00000000-0000-0000-0000-0000000000c1', 'WEB', '1', 'x');
SELECT pg_temp.ok((SELECT count(*) = 1 FROM message_logs_default), 'out-of-range row caught by default partition');
DELETE FROM message_logs_default;

SELECT pg_temp.ok(app.ensure_message_log_partitions() = 0, 'ensure_message_log_partitions is idempotent');
SELECT pg_temp.ok(
  app.ensure_message_log_partitions((current_date + interval '6 months')::date, 1) = 1,
  'ensure_message_log_partitions creates a new month');

-- Sessions for RLS tests: one user + refresh token per client.
INSERT INTO users (id, org_id, email, password_hash) VALUES
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000c1', 'c1@example.com', 'x'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000c2', 'c2@example.com', 'x');
INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at) VALUES
  ('00000000-0000-0000-0000-0000000000f1', gen_random_uuid(), '\x01', now() + interval '1 day'),
  ('00000000-0000-0000-0000-0000000000f2', gen_random_uuid(), '\x02', now() + interval '1 day');

-- 8. RLS ---------------------------------------------------------------------------
SET LOCAL ROLE sms_api;

SELECT pg_temp.ok((SELECT count(*) = 0 FROM organizations), 'no tenant context = sees nothing');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM refresh_tokens), 'no tenant context = sees no refresh tokens');

-- Partitions are reachable only through the RLS-filtered parent.
SELECT pg_temp.expect_error(
  format('SELECT count(*) FROM %I', 'message_logs_' || to_char(now(), 'YYYY_MM')),
  'permission denied');
SELECT pg_temp.expect_error($$SELECT count(*) FROM message_logs_default$$, 'permission denied');
SELECT pg_temp.expect_error(
  format('SELECT count(*) FROM %I', 'message_logs_' || to_char(current_date + interval '6 months', 'YYYY_MM')),
  'permission denied');
SELECT pg_temp.expect_error(
  $$SELECT app.ensure_message_log_partitions((current_date + interval '9 months')::date, 1)$$,
  'permission denied');

SELECT set_config('app.org_id', '00000000-0000-0000-0000-0000000000c1', true), set_config('app.role', 'CLIENT', true);
SELECT pg_temp.ok((SELECT count(*) = 1 FROM organizations), 'client sees only itself');
SELECT pg_temp.ok((SELECT count(*) = 1 FROM message_logs), 'client sees only its messages');
SELECT pg_temp.ok((SELECT count(*) = 1 FROM refresh_tokens), 'client sees only its own sessions');
SELECT pg_temp.expect_error($$SELECT token_hash FROM refresh_tokens$$, 'permission denied');
SELECT pg_temp.expect_error(
  $$INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
    VALUES ('00000000-0000-0000-0000-0000000000f1', gen_random_uuid(), '\x03', now())$$,
  'permission denied');
SELECT pg_temp.expect_error($$DELETE FROM refresh_tokens$$, 'permission denied');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM upstream_connections), 'client cannot see upstream credentials');
SELECT pg_temp.ok((SELECT array_agg(name) = ARRAY['OTP-Premium'] FROM routes), 'client sees only assigned routes');
SELECT pg_temp.ok((SELECT count(*) = 1 FROM route_templates WHERE org_id IS NULL), 'client can read route-wide template');
SELECT pg_temp.expect_error(
  $$INSERT INTO api_keys (org_id, name, key_prefix, key_hash)
    VALUES ('00000000-0000-0000-0000-0000000000c2', 'steal', 'sk_x', '\x00')$$,
  'row-level security');
-- RLS filters UPDATE targets silently, so check the row didn't change.
UPDATE route_templates SET template_body = 'hacked {otp}' WHERE org_id IS NULL;
SELECT pg_temp.ok(
  (SELECT template_body NOT LIKE 'hacked%' FROM route_templates WHERE org_id IS NULL),
  'client cannot edit route-wide template');

SELECT set_config('app.org_id', '00000000-0000-0000-0000-0000000000b1', true), set_config('app.role', 'RESELLER', true);
SELECT pg_temp.ok(
  (SELECT array_agg(name ORDER BY name) = ARRAY['Client 1', 'Reseller 1'] FROM organizations),
  'reseller sees itself and its clients only');
SELECT pg_temp.ok((SELECT count(*) = 1 FROM message_logs), 'reseller sees its clients'' messages only');
UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'user_disabled' WHERE revoked_at IS NULL;
SELECT pg_temp.ok((SELECT count(*) = 2 FROM ip_whitelists), 'reseller sees its clients'' whitelists');
UPDATE organizations SET sending_enabled = false WHERE id = '00000000-0000-0000-0000-0000000000c2';
SELECT pg_temp.ok(true, 'reseller update on foreign client is a no-op (checked as superuser below)');
UPDATE organizations SET smpp_enabled = true WHERE id = '00000000-0000-0000-0000-0000000000c1';
SELECT pg_temp.expect_error(
  $$INSERT INTO organizations (role, parent_id, name)
    VALUES ('CLIENT', '00000000-0000-0000-0000-0000000000b2', 'poach')$$,
  'row-level security');

SELECT set_config('app.org_id', '00000000-0000-0000-0000-0000000000a1', true), set_config('app.role', 'SUPER_ADMIN', true);
SELECT pg_temp.ok((SELECT count(*) = 5 FROM organizations), 'admin sees every org');
SELECT pg_temp.ok((SELECT count(*) = 2 FROM message_logs), 'admin sees all messages');
SELECT pg_temp.ok((SELECT count(*) = 1 FROM upstream_connections), 'admin sees upstreams');

RESET ROLE;
SELECT pg_temp.ok(
  (SELECT sending_enabled FROM organizations WHERE id = '00000000-0000-0000-0000-0000000000c2'),
  'reseller 1 could not stop reseller 2''s client');
SELECT pg_temp.ok(
  (SELECT smpp_enabled FROM organizations WHERE id = '00000000-0000-0000-0000-0000000000c1'),
  'reseller 1 could toggle its own client''s SMPP');
SELECT pg_temp.ok(
  (SELECT revoked_at IS NOT NULL FROM refresh_tokens WHERE user_id = '00000000-0000-0000-0000-0000000000f1'),
  'reseller could revoke its client''s sessions');
SELECT pg_temp.ok(
  (SELECT revoked_at IS NULL FROM refresh_tokens WHERE user_id = '00000000-0000-0000-0000-0000000000f2'),
  'reseller could not revoke another reseller''s client sessions');
SELECT pg_temp.ok(
  (SELECT bool_and(c.relrowsecurity AND NOT has_table_privilege('sms_api', c.oid, 'SELECT'))
     FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'message_logs'::regclass),
  'every message_logs partition has RLS and no sms_api grant');

\echo 'ALL SCHEMA TESTS PASSED'
ROLLBACK;
