/**
 * Test environment (CONTRACTS §1: api uses DB sms_api2 and Redis DB 5 by default).
 * TEST_DB_NAME / TEST_REDIS_DB override them so parallel agents can each use their own.
 */
const TEST_DB = process.env.TEST_DB_NAME ?? 'sms_api2';
const TEST_REDIS_DB = process.env.TEST_REDIS_DB ?? '5';
process.env.DATABASE_URL = `postgres://sms_api_login:sms_api_dev@localhost:5432/${TEST_DB}`;
process.env.DATABASE_URL_PRIVILEGED = `postgres://sms_engine_login:sms_engine_dev@localhost:5432/${TEST_DB}`;
process.env.REDIS_URL = `redis://localhost:6399/${TEST_REDIS_DB}`;
process.env.INTERNAL_TOKEN = 'test-internal-token-0123456789';
process.env.ENGINE_URL = process.env.ENGINE_URL ?? 'http://127.0.0.1:9';
process.env.APP_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
// A realistic (random-looking) value: config now rejects placeholder/low-entropy secrets.
process.env.JWT_SECRET = '9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1908abcdef';
process.env.LEDGER_RECONCILE_INTERVAL_MS = '0';
process.env.ENGINE_TIMEOUT_MS = '2000';
// Pub/sub is not scoped by Redis DB index: use a private channel so other agents' engines
// listening on cfg:invalidate never see test traffic. Production default is cfg:invalidate.
process.env.CFG_INVALIDATE_CHANNEL = `test:${TEST_DB}:cfg:invalidate`;
// Local webhook receivers (127.0.0.1) need the SSRF guard off; webhook-ssrf.e2e-spec.ts turns it on.
process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = '1';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'Admin-Passw0rd!';
// Background workers are driven explicitly by the tests (worker.tick()).
process.env.CAMPAIGN_WORKER_INTERVAL_MS = '0';
process.env.ALERTS_INTERVAL_MS = '0';
// The whole e2e suite logs in many times from 127.0.0.1 within one window, which would trip
// the per-IP login throttle (default 20/60s). Raise it out of the way; the limiter's own
// behavior is covered by login-rate-limiter.spec.ts.
process.env.LOGIN_RATE_LIMIT = '100000';
