-- =============================================================================
-- 010_content_approval.sql — per-client content pre-approval (allow-list)
--
-- When organizations.content_approval_required is true for a CLIENT, every
-- message that client sends must match a piece of content a SUPER_ADMIN has
-- APPROVED for it; anything else is rejected at submit with
-- CONTENT_NOT_APPROVED (engine policy.CheckApprovedContent). Off by default,
-- so this changes nothing until an admin turns it on for a client.
--
-- approved_content mirrors sender_ids: a client (or its reseller, on its
-- behalf) submits content → PENDING; a SUPER_ADMIN approves/rejects. Matching
-- is on a normalized form (lower-case, trimmed, whitespace collapsed) computed
-- by the engine, so spacing/case differences still match; the unique index
-- keys on a hash of the raw text to stop exact duplicates.
-- =============================================================================

BEGIN;

ALTER TABLE organizations
  ADD COLUMN content_approval_required boolean NOT NULL DEFAULT false;

CREATE TYPE content_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE approved_content (
  id           uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid           NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  content      text           NOT NULL,
  status       content_status NOT NULL DEFAULT 'PENDING',
  note         text,
  reviewed_by  uuid           REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at  timestamptz,
  created_at   timestamptz    NOT NULL DEFAULT now(),
  CHECK (length(content) BETWEEN 1 AND 2000)
);

-- One entry per distinct raw text per org (md5 avoids the btree size limit on long text).
CREATE UNIQUE INDEX approved_content_unique ON approved_content (org_id, md5(content));
CREATE INDEX approved_content_org_status ON approved_content (org_id, status);

-- Tenant isolation, exactly like sender_ids (003_rls.sql): own org or a direct child, admin sees all.
ALTER TABLE approved_content ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON approved_content
  USING (app.can_see_org(org_id)) WITH CHECK (app.can_see_org(org_id));

-- 003's blanket GRANT ... ON ALL TABLES only covered tables that existed then,
-- so grant this new table explicitly (sms_api: full CRUD; sms_engine reads it on reload).
GRANT SELECT, INSERT, UPDATE, DELETE ON approved_content TO sms_api, sms_engine;

COMMIT;
