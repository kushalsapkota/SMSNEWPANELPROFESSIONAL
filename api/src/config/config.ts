import { z } from 'zod';
import { DEFAULT_TRUSTED_PROXIES, parseTrustedProxies } from '../common/request.util';

const bool = z
  .string()
  .optional()
  .transform((v) => v === '1' || v?.toLowerCase() === 'true');

const intWithDefault = (def: number, min = 0) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return def;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be an integer >= ${min}` });
        return z.NEVER;
      }
      return n;
    });

const boolDefaultTrue = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? true : v === '1' || v.toLowerCase() === 'true'));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const postgresUrl = z
  .string({ required_error: 'is required' })
  .min(1, 'is required')
  .refine((v) => /^postgres(ql)?:\/\//.test(v), 'must be a postgres:// URL');

export const envSchema = z.object({
  DATABASE_URL: postgresUrl,
  DATABASE_URL_PRIVILEGED: postgresUrl,
  REDIS_URL: z
    .string({ required_error: 'is required' })
    .min(1, 'is required')
    .refine((v) => /^rediss?:\/\//.test(v), 'must be a redis:// URL'),
  INTERNAL_TOKEN: z.string({ required_error: 'is required' }).min(16, 'must be at least 16 characters'),
  ENGINE_URL: z
    .string({ required_error: 'is required' })
    .url('must be a URL')
    .transform((v) => v.replace(/\/+$/, '')),
  APP_ENC_KEY: z
    .string({ required_error: 'is required' })
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be base64 of exactly 32 bytes'),
  JWT_SECRET: z.string({ required_error: 'is required' }).min(32, 'must be at least 32 characters'),

  PORT: intWithDefault(3000, 1),
  /** Believe X-Forwarded-For at all (only from TRUSTED_PROXIES peers; see request.util clientIp). */
  TRUST_PROXY: bool,
  /** Peers allowed to set X-Forwarded-For: CIDRs, IPs, or loopback / linklocal / uniquelocal. */
  TRUSTED_PROXIES: z
    .string()
    .optional()
    .transform((v, ctx) => {
      try {
        return parseTrustedProxies(v && v.trim() !== '' ? v : DEFAULT_TRUSTED_PROXIES);
      } catch (e) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
        return z.NEVER;
      }
    }),
  ENGINE_TIMEOUT_MS: intWithDefault(5000, 100),
  TOTP_ISSUER: z.string().optional().default('SMS Gateway'),
  REFRESH_TOKEN_TTL_DAYS: intWithDefault(30, 1),
  LEDGER_RECONCILE_INTERVAL_MS: intWithDefault(30000, 0),
  DB_POOL_MAX: intWithDefault(20, 1),
  CFG_INVALIDATE_CHANNEL: z.string().optional().default('cfg:invalidate'),
  WEBHOOK_TEST_TIMEOUT_MS: intWithDefault(10000, 100),
  /**
   * Allow webhook URLs on loopback / private / link-local / reserved addresses (SSRF guard off).
   * Dev and tests only (local receivers); keep it off in production.
   */
  WEBHOOK_ALLOW_PRIVATE_TARGETS: bool,

  // Public /v1 API (CONTRACTS §11)
  /** Requests per second per API key (fixed 1s window in Redis). */
  PUBLIC_API_RATE_LIMIT: intWithDefault(100, 1),
  /** api_keys.last_used_at is written at most once per key per this interval. */
  API_KEY_TOUCH_INTERVAL_MS: intWithDefault(60000, 0),

  // Background workers (0 disables the in-process timer)
  CAMPAIGN_WORKER_INTERVAL_MS: intWithDefault(1000, 0),
  ALERTS_INTERVAL_MS: intWithDefault(60000, 0),
  /** An org is alerted at most once per condition per this many seconds. */
  ALERT_DEDUPE_SECONDS: intWithDefault(21600, 1),

  // Alert delivery (each channel is active only when configured)
  SMTP_HOST: optionalString,
  SMTP_PORT: intWithDefault(587, 1),
  SMTP_SECURE: bool,
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  SMTP_FROM: optionalString,
  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_API_URL: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim().replace(/\/+$/, '') : 'https://api.telegram.org')),

  /** Engine Prometheus endpoint (CONTRACTS §1, :9100/metrics) for /api/analytics/live tps_in. */
  ENGINE_METRICS_URL: optionalString,
  /** Serve Swagger UI at /api/docs (+ /api/docs-json). */
  SWAGGER_ENABLED: boolDefaultTrue,
});

export type AppConfig = z.infer<typeof envSchema>;

/** Parses the environment; throws one error listing every missing/invalid variable. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
