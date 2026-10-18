-- DEV/TEST ONLY login roles. Production: create equivalents with real secrets (deploy/).
-- NB: BYPASSRLS is a role attribute and is NOT inherited through membership,
-- so the engine login role must carry it itself.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sms_api_login') THEN
    CREATE ROLE sms_api_login LOGIN PASSWORD 'sms_api_dev' IN ROLE sms_api;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sms_engine_login') THEN
    CREATE ROLE sms_engine_login LOGIN BYPASSRLS PASSWORD 'sms_engine_dev' IN ROLE sms_engine;
  END IF;
END $$;
