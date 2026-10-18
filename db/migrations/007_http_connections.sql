-- =============================================================================
-- 007_http_connections.sql — upstream connections over HTTP provider APIs
--
-- An upstream connection is now either SMPP (host/port/system_id/password) or
-- HTTP (an adapter such as 'sparrow_v2' or 'aakash_v3' plus its credentials).
-- Adapters live in the engine; see docs/providers/nepal-adapters.json.
-- =============================================================================

BEGIN;

ALTER TABLE upstream_connections
  ADD COLUMN kind                 text  NOT NULL DEFAULT 'SMPP' CHECK (kind IN ('SMPP', 'HTTP')),
  ADD COLUMN adapter              text,           -- adapter id, HTTP only
  ADD COLUMN http_credentials_enc text,           -- 'v1:' AES-GCM of a JSON object {key: value}, HTTP only
  ADD COLUMN http_settings        jsonb NOT NULL DEFAULT '{}',  -- non-secret adapter settings
  ADD COLUMN dlr_token            text;           -- random secret in the provider DLR callback URL

ALTER TABLE upstream_connections
  ALTER COLUMN host         DROP NOT NULL,
  ALTER COLUMN port         DROP NOT NULL,
  ALTER COLUMN system_id    DROP NOT NULL,
  ALTER COLUMN password_enc DROP NOT NULL;

ALTER TABLE upstream_connections ADD CONSTRAINT upstream_connections_kind_fields CHECK (
  (kind = 'SMPP' AND host IS NOT NULL AND port IS NOT NULL AND system_id IS NOT NULL
                 AND password_enc IS NOT NULL AND adapter IS NULL)
  OR
  (kind = 'HTTP' AND adapter IS NOT NULL AND http_credentials_enc IS NOT NULL)
);

CREATE UNIQUE INDEX upstream_connections_dlr_token ON upstream_connections (dlr_token)
  WHERE dlr_token IS NOT NULL;

COMMIT;
