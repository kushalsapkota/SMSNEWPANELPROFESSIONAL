-- =============================================================================
-- 006_api_security_fixes.sql — columns the api needs for review fixes
--
--   * Parent-set controls a CLIENT must not undo (RESELLER fully controls its clients):
--       blocked_numbers / blocked_keywords / ip_whitelists.created_by_org_id
--         the REAL org of the creator (the parent also when it acted while impersonating).
--         A row whose creator is not the row's own org may only be removed by that parent.
--         NULL = unknown (pre-006 rows without a matching audit row): not locked.
--       smpp_accounts.locked_by_parent
--         set when the parent creates/updates the account; the org itself may then only
--         tighten it (disable, lower max_binds / max_tps, narrow bind types).
--   * users.totp_last_step: last accepted TOTP time step (30s), so a code is accepted once.
--   * campaign_recipients.attempt_message_id: message id the api sends with an engine submit
--     whose outcome is unknown (timeout / 5xx). The retry reuses it, so the engine's debit is
--     idempotent (debit.lua DUPLICATE) and the recipient is never charged or sent twice.
--   * campaigns.last_chunk_at: clock time the previous chunk finished (pacing between chunks;
--     updated_at cannot be used: the touch trigger sets it to the transaction START time).
-- Only additive, nullable / defaulted columns: the engine is unaffected.
-- =============================================================================

BEGIN;

ALTER TABLE blocked_numbers  ADD COLUMN created_by_org_id uuid REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE blocked_keywords ADD COLUMN created_by_org_id uuid REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE ip_whitelists    ADD COLUMN created_by_org_id uuid REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE smpp_accounts    ADD COLUMN locked_by_parent boolean NOT NULL DEFAULT false;
ALTER TABLE users            ADD COLUMN totp_last_step bigint;
ALTER TABLE campaign_recipients ADD COLUMN attempt_message_id uuid;
ALTER TABLE campaigns        ADD COLUMN last_chunk_at timestamptz;

-- Backfill creators from what we already know.
UPDATE ip_whitelists w
   SET created_by_org_id = u.org_id
  FROM users u
 WHERE u.id = w.created_by_user_id;

UPDATE blocked_numbers b
   SET created_by_org_id = (SELECT u.org_id FROM audit_logs a JOIN users u ON u.id = a.actor_user_id
                             WHERE a.action = 'blocklist.number_add' AND a.entity_id = b.id::text
                             ORDER BY a.id LIMIT 1);

UPDATE blocked_keywords b
   SET created_by_org_id = (SELECT u.org_id FROM audit_logs a JOIN users u ON u.id = a.actor_user_id
                             WHERE a.action = 'blocklist.keyword_add' AND a.entity_id = b.id::text
                             ORDER BY a.id LIMIT 1);

UPDATE smpp_accounts s
   SET locked_by_parent = true
 WHERE EXISTS (SELECT 1 FROM audit_logs a JOIN users u ON u.id = a.actor_user_id
                WHERE a.entity_type = 'smpp_account' AND a.entity_id = s.id::text
                  AND a.action IN ('smpp_account.create', 'smpp_account.update')
                  AND u.org_id <> s.org_id);

COMMIT;
