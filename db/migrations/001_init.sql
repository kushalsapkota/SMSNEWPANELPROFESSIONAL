-- =============================================================================
-- 001_init.sql — core schema for the 3-tier SMS gateway
--
-- Conventions
--   * All money is BIGINT "micros": 1 currency unit = 1_000_000 micros.
--     Same unit is used in Redis so balances never pass through floats.
--   * Hierarchy: SUPER_ADMIN -> RESELLER -> CLIENT (enforced by trigger).
--   * Billing is dual-debit: on every send the CLIENT is debited at its rate
--     (money it owes the reseller) and the RESELLER is debited at its rate
--     (money it owes the admin). Reseller "top-ups" of clients therefore never
--     move reseller credit — they only record that the client paid.
--   * Hot-path tables (message_logs) carry no FKs on purpose: the engine
--     writes them in batches and integrity is guaranteed upstream.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA IF NOT EXISTS app;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------

-- Time-ordered UUIDv7 (PG16 has no native one). Keeps message_logs inserts
-- append-mostly on the btree and makes ids roughly sortable by time.
CREATE OR REPLACE FUNCTION app.uuid_generate_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  RETURN encode(
    set_bit(set_bit(
      overlay(uuid_send(gen_random_uuid())
              PLACING substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
              FROM 1 FOR 6),
      52, 1), 53, 1),
    'hex')::uuid;
END $$;

CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

CREATE TYPE org_role          AS ENUM ('SUPER_ADMIN', 'RESELLER', 'CLIENT');
CREATE TYPE org_status        AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');
CREATE TYPE billing_mode      AS ENUM ('PREPAID', 'POSTPAID');
CREATE TYPE bind_type         AS ENUM ('TX', 'RX', 'TRX');
CREATE TYPE template_fallback AS ENUM ('REJECT', 'SEND_RAW', 'SEND_DEFAULT_TEMPLATE');
CREATE TYPE ip_scope          AS ENUM ('API', 'SMPP', 'PANEL', 'ALL');
CREATE TYPE msg_channel       AS ENUM ('HTTP', 'SMPP', 'WEB');
CREATE TYPE msg_encoding      AS ENUM ('GSM7', 'UCS2');
CREATE TYPE msg_status        AS ENUM (
  'ACCEPTED',     -- passed validation + debit, not yet queued
  'QUEUED',       -- in dispatcher queue
  'SUBMITTED',    -- submit_sm_resp OK from upstream
  'DELIVERED',
  'UNDELIVERED',
  'FAILED',       -- upstream/system error, refundable
  'EXPIRED',
  'REJECTED',     -- rejected by us (template REJECT, blacklist, ...) or upstream
  'UNKNOWN'
);
CREATE TYPE ledger_type       AS ENUM ('TOPUP', 'DEDUCT', 'ADJUSTMENT', 'REFUND', 'USAGE_SETTLEMENT');
CREATE TYPE sender_status     AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- -----------------------------------------------------------------------------
-- Tenancy
-- -----------------------------------------------------------------------------

CREATE TABLE organizations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role               org_role    NOT NULL,
  parent_id          uuid        REFERENCES organizations(id) ON DELETE RESTRICT,
  name               text        NOT NULL,
  status             org_status  NOT NULL DEFAULT 'ACTIVE',
  suspended_reason   text,

  -- Channel / sending toggles (reseller controls these for its clients).
  sending_enabled    boolean     NOT NULL DEFAULT true,   -- "stop sending" without suspending login
  api_enabled        boolean     NOT NULL DEFAULT true,
  smpp_enabled       boolean     NOT NULL DEFAULT false,
  web_enabled        boolean     NOT NULL DEFAULT true,

  -- Velocity limits.
  max_tps            integer     NOT NULL DEFAULT 10 CHECK (max_tps > 0),
  daily_limit        integer     CHECK (daily_limit > 0),
  monthly_limit      integer     CHECK (monthly_limit > 0),

  brand_name         text,       -- fills {brand} in templates
  whitelabel_domain  citext      UNIQUE,
  timezone           text        NOT NULL DEFAULT 'UTC',
  settings           jsonb       NOT NULL DEFAULT '{}',

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT org_root_has_no_parent CHECK ((role = 'SUPER_ADMIN') = (parent_id IS NULL))
);

CREATE INDEX organizations_parent_idx ON organizations (parent_id);

CREATE OR REPLACE FUNCTION app.enforce_org_hierarchy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  parent_role org_role;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.role <> OLD.role THEN
    RAISE EXCEPTION 'organization role is immutable (% -> %)', OLD.role, NEW.role;
  END IF;

  IF NEW.role = 'SUPER_ADMIN' THEN
    RETURN NEW;
  END IF;

  SELECT role INTO parent_role FROM organizations WHERE id = NEW.parent_id;

  IF NEW.role = 'RESELLER' AND parent_role IS DISTINCT FROM 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'RESELLER must belong to a SUPER_ADMIN (got %)', parent_role;
  ELSIF NEW.role = 'CLIENT' AND parent_role IS DISTINCT FROM 'RESELLER' THEN
    RAISE EXCEPTION 'CLIENT must belong to a RESELLER (got %)', parent_role;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER organizations_hierarchy
  BEFORE INSERT OR UPDATE OF role, parent_id ON organizations
  FOR EACH ROW EXECUTE FUNCTION app.enforce_org_hierarchy();

CREATE TRIGGER organizations_touch
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- What the engine actually checks: a suspended / stopped reseller blocks all
-- of its clients without touching the client rows.
CREATE VIEW app.org_effective_state WITH (security_invoker = true) AS
SELECT
  o.id,
  o.role,
  o.parent_id,
  (o.status = 'ACTIVE' AND coalesce(p.status = 'ACTIVE', true))                       AS is_active,
  (o.status = 'ACTIVE' AND coalesce(p.status = 'ACTIVE', true)
     AND o.sending_enabled AND coalesce(p.sending_enabled, true))                     AS can_send,
  (o.status = 'ACTIVE' AND coalesce(p.status = 'ACTIVE', true)
     AND o.sending_enabled AND coalesce(p.sending_enabled, true)
     AND o.api_enabled AND coalesce(p.api_enabled, true))                             AS can_api,
  (o.status = 'ACTIVE' AND coalesce(p.status = 'ACTIVE', true)
     AND o.sending_enabled AND coalesce(p.sending_enabled, true)
     AND o.smpp_enabled AND coalesce(p.smpp_enabled, true))                           AS can_smpp,
  least(o.max_tps, coalesce(p.max_tps, o.max_tps))                                    AS effective_max_tps
FROM organizations o
LEFT JOIN organizations p ON p.id = o.parent_id AND p.role = 'RESELLER';

-- -----------------------------------------------------------------------------
-- Users & auth
-- -----------------------------------------------------------------------------

CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email                citext      NOT NULL UNIQUE,
  password_hash        text        NOT NULL,          -- argon2id
  full_name            text,
  is_active            boolean     NOT NULL DEFAULT true,

  totp_secret_enc      bytea,                         -- app-level AES-GCM
  totp_enabled         boolean     NOT NULL DEFAULT false,
  totp_recovery_hashes text[]      NOT NULL DEFAULT '{}',

  failed_login_count   integer     NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  last_login_ip        inet,
  password_changed_at  timestamptz NOT NULL DEFAULT now(),

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT totp_needs_secret CHECK (NOT totp_enabled OR totp_secret_enc IS NOT NULL)
);

CREATE INDEX users_org_idx ON users (org_id);

CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Refresh-token rotation with reuse detection: every refresh issues a new
-- token in the same family; presenting an already-rotated token revokes the
-- whole family.
CREATE TABLE refresh_tokens (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id      uuid        NOT NULL,
  token_hash     bytea       NOT NULL UNIQUE,          -- sha256(token)
  replaced_by    uuid        REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  impersonated_org_id uuid   REFERENCES organizations(id) ON DELETE CASCADE,
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_reason text,
  created_ip     inet,
  user_agent     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user_live_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- -----------------------------------------------------------------------------
-- Balances & ledger
-- -----------------------------------------------------------------------------

-- Snapshot of the balance. Redis is authoritative while a key is loaded;
-- a syncer writes Redis -> here, and hydration reads here -> Redis.
CREATE TABLE accounts_balance (
  org_id                   uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  billing_mode             billing_mode NOT NULL DEFAULT 'PREPAID',
  balance_micros           bigint       NOT NULL DEFAULT 0,
  credit_limit_micros      bigint       NOT NULL DEFAULT 0 CHECK (credit_limit_micros >= 0),
  currency                 char(3)      NOT NULL DEFAULT 'USD',
  low_balance_alert_micros bigint,
  synced_at                timestamptz,
  updated_at               timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT prepaid_has_no_credit CHECK (billing_mode = 'POSTPAID' OR credit_limit_micros = 0)
);

CREATE TRIGGER accounts_balance_touch BEFORE UPDATE ON accounts_balance
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE balance_transactions (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id              uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type                ledger_type NOT NULL,
  amount_micros       bigint      NOT NULL CHECK (amount_micros <> 0),   -- signed
  balance_after_micros bigint,
  idempotency_key     text        UNIQUE,                                -- also the Redis topup key
  reference           text,
  note                text,
  created_by_user_id  uuid        REFERENCES users(id) ON DELETE SET NULL,
  applied_at          timestamptz,                                       -- set once applied in Redis
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX balance_transactions_org_idx ON balance_transactions (org_id, created_at DESC);
CREATE INDEX balance_transactions_unapplied_idx ON balance_transactions (created_at) WHERE applied_at IS NULL;

-- -----------------------------------------------------------------------------
-- Upstream connections & routes (admin-owned)
-- -----------------------------------------------------------------------------

CREATE TABLE upstream_connections (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     text        NOT NULL UNIQUE,
  host                     text        NOT NULL,
  port                     integer     NOT NULL CHECK (port BETWEEN 1 AND 65535),
  use_tls                  boolean     NOT NULL DEFAULT false,
  system_id                varchar(15) NOT NULL,       -- SMPP 3.4: C-Octet String max 16 incl. NUL
  password_enc             text        NOT NULL,       -- app-level encrypted; plaintext max 8 chars
  system_type              varchar(12) NOT NULL DEFAULT '',
  bind_type                bind_type   NOT NULL DEFAULT 'TRX',
  sessions                 smallint    NOT NULL DEFAULT 1 CHECK (sessions BETWEEN 1 AND 64),
  max_tps                  integer     NOT NULL CHECK (max_tps > 0),       -- across all sessions
  window_size              smallint    NOT NULL DEFAULT 10 CHECK (window_size > 0),
  enquire_link_interval_s  smallint    NOT NULL DEFAULT 30 CHECK (enquire_link_interval_s > 0),
  reconnect_min_s          smallint    NOT NULL DEFAULT 1,
  reconnect_max_s          smallint    NOT NULL DEFAULT 60,
  submit_timeout_ms        integer     NOT NULL DEFAULT 10000,
  request_dlr              boolean     NOT NULL DEFAULT true,  -- registered_delivery = 1
  multipart_mode           text        NOT NULL DEFAULT 'UDH' CHECK (multipart_mode IN ('UDH', 'SAR', 'PAYLOAD')),
  default_data_coding      smallint    NOT NULL DEFAULT 0,
  enabled                  boolean     NOT NULL DEFAULT true,
  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  UNIQUE (host, port, system_id),
  CHECK (reconnect_min_s > 0 AND reconnect_max_s >= reconnect_min_s)
);

CREATE TRIGGER upstream_connections_touch BEFORE UPDATE ON upstream_connections
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- What the upstream charges us, per destination prefix (longest prefix wins).
CREATE TABLE upstream_rates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id   uuid        NOT NULL REFERENCES upstream_connections(id) ON DELETE CASCADE,
  prefix          varchar(15) NOT NULL DEFAULT '' CHECK (prefix ~ '^[0-9]*$'),
  cost_micros     bigint      NOT NULL CHECK (cost_micros >= 0),
  effective_from  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, prefix, effective_from)
);

CREATE TABLE routes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text        NOT NULL UNIQUE,
  description        text,
  enabled            boolean     NOT NULL DEFAULT true,
  template_mode      boolean     NOT NULL DEFAULT false,
  template_fallback  template_fallback NOT NULL DEFAULT 'SEND_RAW',
  force_sender_id    varchar(16),          -- overrides client sender on this route
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER routes_touch BEFORE UPDATE ON routes
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- A route fans out to one or more connections: lowest priority number first
-- (failover), weighted load-balancing between equal priorities.
CREATE TABLE route_connections (
  route_id       uuid     NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  connection_id  uuid     NOT NULL REFERENCES upstream_connections(id) ON DELETE CASCADE,
  priority       smallint NOT NULL DEFAULT 1 CHECK (priority > 0),
  weight         smallint NOT NULL DEFAULT 100 CHECK (weight > 0),
  enabled        boolean  NOT NULL DEFAULT true,
  PRIMARY KEY (route_id, connection_id)
);

CREATE INDEX route_connections_conn_idx ON route_connections (connection_id);

-- -----------------------------------------------------------------------------
-- Route templates (OTP rewriting)
-- -----------------------------------------------------------------------------

-- org_id NULL = route-wide default; non-NULL = per-client override.
-- Patterns must be RE2-compatible (no look-around) because the Go engine
-- evaluates them. They are tried in order; the first match wins.
--
-- NB: the second default pattern requires at least one letter AND one digit.
-- A plain \b[A-Za-z0-9]{5,8}\b would happily "extract" words like "valid".
CREATE TABLE route_templates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id          uuid        NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  org_id            uuid        REFERENCES organizations(id) ON DELETE CASCADE,
  name              text        NOT NULL,
  extract_patterns  text[]      NOT NULL DEFAULT ARRAY[
                                  '\b[0-9]{4,8}\b',
                                  '\b[A-Za-z0-9]*(?:[A-Za-z][0-9]|[0-9][A-Za-z])[A-Za-z0-9]*\b'
                                ],
  otp_min_len       smallint    NOT NULL DEFAULT 4,
  otp_max_len       smallint    NOT NULL DEFAULT 8,
  template_body     text        NOT NULL CHECK (position('{otp}' IN template_body) > 0),
  default_body      text,                       -- used by SEND_DEFAULT_TEMPLATE
  fallback_action   template_fallback,          -- NULL = inherit routes.template_fallback
  brand             text,                       -- NULL = inherit organizations.brand_name
  is_active         boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CHECK (cardinality(extract_patterns) BETWEEN 1 AND 10),
  CHECK (otp_min_len > 0 AND otp_max_len >= otp_min_len),
  CHECK (fallback_action IS DISTINCT FROM 'SEND_DEFAULT_TEMPLATE' OR default_body IS NOT NULL)
);

-- At most one active template per (route, client) and one route-wide default.
CREATE UNIQUE INDEX route_templates_one_active
  ON route_templates (route_id, org_id) NULLS NOT DISTINCT
  WHERE is_active;

CREATE TRIGGER route_templates_touch BEFORE UPDATE ON route_templates
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Route assignments (admin -> reseller, reseller -> client)
-- -----------------------------------------------------------------------------

CREATE TABLE org_route_assignments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  route_id       uuid        NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  prefix         varchar(15) NOT NULL DEFAULT '' CHECK (prefix ~ '^[0-9]*$'),  -- '' = all destinations
  rate_micros    bigint      NOT NULL CHECK (rate_micros >= 0),               -- per segment, what org pays
  priority       smallint    NOT NULL DEFAULT 1 CHECK (priority > 0),
  enabled        boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, route_id, prefix)
);

CREATE INDEX org_route_assignments_lookup ON org_route_assignments (org_id, prefix) WHERE enabled;
CREATE INDEX org_route_assignments_route_idx ON org_route_assignments (route_id);

CREATE TRIGGER org_route_assignments_touch BEFORE UPDATE ON org_route_assignments
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- A reseller can only hand out routes the admin gave it.
-- Integrity triggers are SECURITY DEFINER so they see the real hierarchy,
-- not the caller's RLS-filtered view of it.
CREATE OR REPLACE FUNCTION app.enforce_route_assignment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  o organizations%ROWTYPE;
BEGIN
  SELECT * INTO o FROM organizations WHERE id = NEW.org_id;

  IF o.role = 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'routes are not assigned to SUPER_ADMIN';
  END IF;

  IF o.role = 'CLIENT' AND NOT EXISTS (
    SELECT 1 FROM org_route_assignments
    WHERE org_id = o.parent_id AND route_id = NEW.route_id AND enabled
  ) THEN
    RAISE EXCEPTION 'route % is not assigned to reseller %', NEW.route_id, o.parent_id;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER org_route_assignments_check
  BEFORE INSERT OR UPDATE OF org_id, route_id, enabled ON org_route_assignments
  FOR EACH ROW WHEN (NEW.enabled)
  EXECUTE FUNCTION app.enforce_route_assignment();

-- Taking a route away from a reseller takes it away from its clients too.
CREATE OR REPLACE FUNCTION app.cascade_route_unassign() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  reseller_id uuid := OLD.org_id;
BEGIN
  IF (SELECT role FROM organizations WHERE id = reseller_id) IS DISTINCT FROM 'RESELLER' THEN
    RETURN NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM org_route_assignments
             WHERE org_id = reseller_id AND route_id = OLD.route_id AND enabled) THEN
    RETURN NULL;   -- reseller still has this route under another prefix
  END IF;

  UPDATE org_route_assignments a
     SET enabled = false
    FROM organizations c
   WHERE a.org_id = c.id
     AND c.parent_id = reseller_id
     AND a.route_id = OLD.route_id
     AND a.enabled;

  RETURN NULL;
END $$;

CREATE TRIGGER org_route_assignments_cascade_delete
  AFTER DELETE ON org_route_assignments
  FOR EACH ROW EXECUTE FUNCTION app.cascade_route_unassign();

CREATE TRIGGER org_route_assignments_cascade_disable
  AFTER UPDATE OF enabled ON org_route_assignments
  FOR EACH ROW WHEN (OLD.enabled AND NOT NEW.enabled)
  EXECUTE FUNCTION app.cascade_route_unassign();

-- -----------------------------------------------------------------------------
-- Sender IDs
-- -----------------------------------------------------------------------------

CREATE TABLE sender_ids (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid          NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  route_id     uuid          REFERENCES routes(id) ON DELETE CASCADE,   -- NULL = any route
  sender       varchar(16)   NOT NULL,
  status       sender_status NOT NULL DEFAULT 'PENDING',
  reviewed_by  uuid          REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at  timestamptz,
  created_at   timestamptz   NOT NULL DEFAULT now(),

  -- Alphanumeric: max 11 chars (TON 5). Numeric: E.164, max 15 digits (TON 1).
  CHECK (sender ~ '^\+?[0-9]{1,15}$' OR sender ~ '^[A-Za-z0-9 ._-]{1,11}$')
);

CREATE UNIQUE INDEX sender_ids_unique ON sender_ids (org_id, sender, route_id) NULLS NOT DISTINCT;

-- -----------------------------------------------------------------------------
-- Client credentials & access control
-- -----------------------------------------------------------------------------

CREATE TABLE api_keys (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name               text        NOT NULL,
  key_prefix         varchar(16) NOT NULL UNIQUE,     -- shown in UI, e.g. "sk_live_ab12"
  key_hash           bytea       NOT NULL UNIQUE,     -- sha256(full key); keys are high-entropy
  scopes             text[]      NOT NULL DEFAULT ARRAY['sms:send', 'sms:read'],
  last_used_at       timestamptz,
  expires_at         timestamptz,
  revoked_at         timestamptz,
  created_by_user_id uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX api_keys_org_idx ON api_keys (org_id);

CREATE TABLE smpp_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  system_id           varchar(15) NOT NULL UNIQUE,
  password_hash       text        NOT NULL,          -- plaintext max 8 chars (SMPP 3.4)
  allowed_bind_types  bind_type[] NOT NULL DEFAULT ARRAY['TX', 'TRX']::bind_type[],
  max_binds           smallint    NOT NULL DEFAULT 2 CHECK (max_binds > 0),
  max_tps             integer     CHECK (max_tps > 0),  -- NULL = organizations.max_tps
  enabled             boolean     NOT NULL DEFAULT true,
  last_bind_at        timestamptz,
  last_bind_ip        inet,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX smpp_accounts_org_idx ON smpp_accounts (org_id);

CREATE TRIGGER smpp_accounts_touch BEFORE UPDATE ON smpp_accounts
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- No rows for a scope (or ALL) = that channel is open from any IP.
CREATE TABLE ip_whitelists (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  cidr                cidr        NOT NULL,
  scope               ip_scope    NOT NULL DEFAULT 'ALL',
  note                text,
  created_by_user_id  uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, cidr, scope)
);

CREATE INDEX ip_whitelists_cidr_idx ON ip_whitelists USING gist (cidr inet_ops);

CREATE OR REPLACE FUNCTION app.ip_allowed(p_org uuid, p_ip inet, p_scope ip_scope) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (SELECT 1 FROM ip_whitelists
                      WHERE org_id = p_org AND scope IN (p_scope, 'ALL'))
      OR EXISTS     (SELECT 1 FROM ip_whitelists
                      WHERE org_id = p_org AND scope IN (p_scope, 'ALL') AND cidr >>= p_ip);
$$;

CREATE TABLE webhooks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url             text        NOT NULL CHECK (url ~ '^https?://'),
  secret_enc      text        NOT NULL,          -- HMAC-SHA256 signing secret
  events          text[]      NOT NULL DEFAULT ARRAY['dlr'],
  max_retries     smallint    NOT NULL DEFAULT 8 CHECK (max_retries BETWEEN 0 AND 20),
  enabled         boolean     NOT NULL DEFAULT true,
  failure_count   integer     NOT NULL DEFAULT 0,
  last_failure_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX webhooks_org_idx ON webhooks (org_id) WHERE enabled;

CREATE TRIGGER webhooks_touch BEFORE UPDATE ON webhooks
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Audit log (append-only)
-- -----------------------------------------------------------------------------

CREATE TABLE audit_logs (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at            timestamptz NOT NULL DEFAULT now(),
  actor_user_id         uuid,
  actor_org_id          uuid,
  impersonator_user_id  uuid,          -- set when a reseller/admin acts as a client
  target_org_id         uuid,
  action                text        NOT NULL,     -- e.g. 'client.suspend', 'route.assign'
  entity_type           text,
  entity_id             text,
  before                jsonb,
  after                 jsonb,
  ip                    inet,
  user_agent            text
);

CREATE INDEX audit_logs_target_idx ON audit_logs (target_org_id, created_at DESC);
CREATE INDEX audit_logs_actor_idx  ON audit_logs (actor_org_id, created_at DESC);

CREATE OR REPLACE FUNCTION app.audit_logs_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END $$;

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION app.audit_logs_immutable();

COMMIT;
