-- =============================================================================
-- 008_smpp_password_reveal.sql — let the parent and admin re-read an SMPP bind password
--
-- SMPP bind verification stays on password_hash (argon2, the engine checks it). This adds an
-- app-level encrypted copy of the same password so the panel can show / copy the full connection
-- (host, port, system_id, password) after the account is created — the same reversible storage
-- upstream_connections.password_enc already uses. password_hash is still the source of truth for
-- binding; password_enc is display-only and may be NULL for accounts created before this migration
-- (rotate the password once to populate it).
-- =============================================================================

BEGIN;

ALTER TABLE smpp_accounts
  ADD COLUMN password_enc text;  -- app-encrypted (v1:...) copy of the bind password; NULL = not revealable

COMMENT ON COLUMN smpp_accounts.password_enc IS
  'App-level encrypted copy of the bind password for display/copy by the parent and admin. '
  'NULL for pre-008 accounts until the password is next set. Binding still uses password_hash.';

COMMIT;
