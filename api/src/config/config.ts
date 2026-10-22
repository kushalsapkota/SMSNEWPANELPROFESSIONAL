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

/** Common placeholder/example secrets that must never reach production. */
const WEAK_SECRET_RE = /(changeme|change-me|secret|password|passw0rd|example|replace|placeholder|dummy|default|test1234|insecure|^0+$|^(.)\1+$)/i;

/**
 * Rejects secrets that pass a length check but are obviously weak: a well-known placeholder,
 * a single repeated character, or too few distinct characters to carry real entropy.
 */
const strongSecret = (field: z.ZodString, minDistinct: number) =>
  field.refine((v) => !WEAK_SECRET_RE.test(v) && new Set(v).size >= minDistinct, {
    message: `looks weak or is a known placeholder; use a randomly generated value (needs >= ${minDistinct} distinct characters)`,
  });

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
  INTERNAL_TOKEN: strongSecret(z.string({ required_error: 'is required' }).min(16, 'must be at least 16 characters'), 10),
  ENGINE_URL: z
    .string({ required_error: 'is required' })
    .url('must be a URL')
    .transform((v) => v.replace(/\/+$/, '')),
  APP_ENC_KEY: z
    .string({ required_error: 'is required' })
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be base64 of exactly 32 bytes'),
  JWT_SECRET: strongSecret(z.string({ required_error: 'is required' }).min(32, 'must be at least 32 characters'), 12),

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
  // Domain used to auto-generate a client's login email in bulk create when none is given
  // (e.g. "casino3" -> "casino3@clients.local"). Admins can still set an explicit email per row.
  CLIENT_EMAIL_DOMAIN: z.string().trim().toLowerCase().optional().default('clients.local'),
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

  // Panel login brute-force protection (defense-in-depth; nginx also throttles /api/auth/login per IP).
  /** Max login attempts per client IP per LOGIN_RATE_WINDOW_S window (fixed window in Redis). */
  LOGIN_RATE_LIMIT: intWithDefault(20, 1),
  /** Window length, in seconds, for LOGIN_RATE_LIMIT. */
  LOGIN_RATE_WINDOW_S: intWithDefault(60, 1),

  // HTTP upstream connections (docs/providers/HTTP-CONNECTIONS-CONTRACT.md)
  /**
   * Public base URL of this deployment (e.g. https://sms.example.com; nginx proxies /v1/ to the api).
   * Used to show admins the provider DLR callback URL `${PUBLIC_API_BASE_URL}/v1/provider-dlr/<token>`.
   * Unset → responses carry dlr_callback_url: null and only dlr_callback_path.
   */
  PUBLIC_API_BASE_URL: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return undefined;
      const t = v.trim().replace(/\/+$/, '');
      if (!/^https?:\/\/[^\s/]+/.test(t)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be an http(s):// URL' });
        return z.NEVER;
      }
      return t;
    }),
  /** Engine adapter catalogue cache (GET /internal/v1/adapters). */
  ADAPTER_CATALOGUE_TTL_MS: intWithDefault(60000, 0),
  /** Provider DLR callbacks: requests per second per dlr_token, and per client IP. */
  PROVIDER_DLR_RATE_LIMIT: intWithDefault(200, 1),
  PROVIDER_DLR_IP_RATE_LIMIT: intWithDefault(400, 1),

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

  // Geo-IP enrichment for the live SMPP sessions monitor (country/city/ISP of each bind IP).
  /** Off → the monitor shows no location (no IP ever leaves this deployment). Default on. */
  GEOIP_ENABLED: boolDefaultTrue,
  /**
   * Lookup URL template; `{ip}` is replaced with the (URL-encoded) bind IP. The default is the
   * free, keyless ip-api.com. Point it at a self-hosted service to keep lookups in-house.
   * Parsed for ip-api.com's field names (country, countryCode, city, isp) and ipinfo-style (loc/org).
   */
  GEOIP_ENDPOINT: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim() : 'http://ip-api.com/json/{ip}?fields=status,country,countryCode,city,isp,query')),
  /** How long a resolved IP→location is cached in Redis (IPs are stable, so this can be long). */
  GEOIP_CACHE_TTL_S: intWithDefault(604800, 60),

  // Host firewall GUI (admin only). The API talks to the privileged firewall-agent container over
  // a Unix socket on a shared volume. Empty FW_AGENT_TOKEN → the feature reports "not configured".
  FW_AGENT_SOCKET: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim() : '/run/fwagent/agent.sock')),
  FW_AGENT_TOKEN: optionalString,

  // Domain/vhost manager (admin only). The API talks to the privileged host domain-agent (systemd)
  // over a Unix socket (bind-mounted from the host). Empty DOMAIN_AGENT_TOKEN → "not configured".
  DOMAIN_AGENT_SOCKET: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim() : '/run/domainagent/agent.sock')),
  DOMAIN_AGENT_TOKEN: optionalString,
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
