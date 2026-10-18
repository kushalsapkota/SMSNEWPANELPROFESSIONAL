/** Test environment (CONTRACTS §1: api uses DB sms_api2 and Redis DB 5). */
process.env.DATABASE_URL = 'postgres://sms_api_login:sms_api_dev@localhost:5432/sms_api2';
process.env.DATABASE_URL_PRIVILEGED = 'postgres://sms_engine_login:sms_engine_dev@localhost:5432/sms_api2';
process.env.REDIS_URL = 'redis://localhost:6399/5';
process.env.INTERNAL_TOKEN = 'test-internal-token-0123456789';
process.env.ENGINE_URL = process.env.ENGINE_URL ?? 'http://127.0.0.1:9';
process.env.APP_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.JWT_SECRET = 'test-jwt-secret-0123456789-abcdefghijklmnop';
process.env.LEDGER_RECONCILE_INTERVAL_MS = '0';
process.env.ENGINE_TIMEOUT_MS = '2000';
// Pub/sub is not scoped by Redis DB index: use a private channel so other agents' engines
// listening on cfg:invalidate never see test traffic. Production default is cfg:invalidate.
process.env.CFG_INVALIDATE_CHANNEL = 'test:sms_api2:cfg:invalidate';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'Admin-Passw0rd!';
// Background workers are driven explicitly by the tests (worker.tick()).
process.env.CAMPAIGN_WORKER_INTERVAL_MS = '0';
process.env.ALERTS_INTERVAL_MS = '0';
