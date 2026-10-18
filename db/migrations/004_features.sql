-- =============================================================================
-- 004_features.sql — blocklists, campaigns, notifications, webhook log
-- =============================================================================

BEGIN;

-- Destination / keyword blocking. org_id NULL = global (admin-managed).
-- A reseller's rows apply to all of its clients.
CREATE TABLE blocked_numbers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid        REFERENCES organizations(id) ON DELETE CASCADE,
  prefix      varchar(15) NOT NULL CHECK (prefix ~ '^[0-9]{1,15}$'),  -- full MSISDN = exact block
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX blocked_numbers_unique ON blocked_numbers (org_id, prefix) NULLS NOT DISTINCT;

CREATE TABLE blocked_keywords (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid        REFERENCES organizations(id) ON DELETE CASCADE,
  pattern     text        NOT NULL,          -- RE2, case-insensitive
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE campaign_status AS ENUM ('DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED');

CREATE TABLE campaigns (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid            NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                text            NOT NULL,
  source_addr         varchar(16)     NOT NULL,
  body                text            NOT NULL,   -- may contain {col} placeholders from the CSV
  status              campaign_status NOT NULL DEFAULT 'DRAFT',
  scheduled_at        timestamptz,
  started_at          timestamptz,
  finished_at         timestamptz,
  total               integer         NOT NULL DEFAULT 0,
  submitted           integer         NOT NULL DEFAULT 0,
  failed              integer         NOT NULL DEFAULT 0,
  created_by_user_id  uuid            REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz     NOT NULL DEFAULT now(),
  updated_at          timestamptz     NOT NULL DEFAULT now()
);
CREATE INDEX campaigns_org_idx ON campaigns (org_id, created_at DESC);
CREATE INDEX campaigns_due_idx ON campaigns (scheduled_at) WHERE status = 'SCHEDULED';
CREATE TRIGGER campaigns_touch BEFORE UPDATE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE campaign_recipients (
  campaign_id   uuid        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  seq           integer     NOT NULL,
  destination   varchar(21) NOT NULL,
  vars          jsonb       NOT NULL DEFAULT '{}',
  message_id    uuid,
  error_code    text,
  PRIMARY KEY (campaign_id, seq)
);
CREATE INDEX campaign_recipients_pending ON campaign_recipients (campaign_id, seq)
  WHERE message_id IS NULL AND error_code IS NULL;

-- Low-balance / route-down alerts.
CREATE TABLE notification_settings (
  org_id            uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  email_enabled     boolean NOT NULL DEFAULT true,
  email_to          text[]  NOT NULL DEFAULT '{}',
  telegram_enabled  boolean NOT NULL DEFAULT false,
  telegram_chat_id  text,
  low_balance       boolean NOT NULL DEFAULT true,
  route_down        boolean NOT NULL DEFAULT true,   -- admin only
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Webhook delivery attempts (for the client's "webhook logs" page).
CREATE TABLE webhook_deliveries (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  webhook_id     uuid        NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  org_id         uuid        NOT NULL,
  message_id     uuid,
  attempt        smallint    NOT NULL,
  status_code    smallint,
  error          text,
  duration_ms    integer,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_org_idx ON webhook_deliveries (org_id, created_at DESC);

-- RLS -------------------------------------------------------------------------
ALTER TABLE blocked_numbers ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON blocked_numbers FOR SELECT
  USING (org_id IS NULL OR app.can_see_org(org_id));
CREATE POLICY tenant_write ON blocked_numbers FOR ALL
  USING (app.is_admin() OR (org_id IS NOT NULL AND app.can_see_org(org_id)))
  WITH CHECK (app.is_admin() OR (org_id IS NOT NULL AND app.can_see_org(org_id)));

ALTER TABLE blocked_keywords ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON blocked_keywords FOR SELECT
  USING (org_id IS NULL OR app.can_see_org(org_id));
CREATE POLICY tenant_write ON blocked_keywords FOR ALL
  USING (app.is_admin() OR (org_id IS NOT NULL AND app.can_see_org(org_id)))
  WITH CHECK (app.is_admin() OR (org_id IS NOT NULL AND app.can_see_org(org_id)));

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['campaigns', 'notification_settings', 'webhook_deliveries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (app.can_see_org(org_id)) WITH CHECK (app.can_see_org(org_id))', t);
  END LOOP;
END $$;

ALTER TABLE campaign_recipients ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaign_recipients
  USING (EXISTS (SELECT 1 FROM campaigns c WHERE c.id = campaign_id AND app.can_see_org(c.org_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM campaigns c WHERE c.id = campaign_id AND app.can_see_org(c.org_id)));

GRANT SELECT, INSERT, UPDATE, DELETE ON
  blocked_numbers, blocked_keywords, campaigns, campaign_recipients, notification_settings, webhook_deliveries
  TO sms_api, sms_engine;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO sms_api, sms_engine;

COMMIT;
