import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
import { RedisService } from '../redis/redis.module';

/** INCR + EXPIRE in one round trip; returns the count in the current window. */
const WINDOW_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
return c`;

export interface LoginRateDecision {
  allowed: boolean;
  limit: number;
  retryAfterSeconds: number;
}

/**
 * Per-IP brute-force throttle for panel login (defense-in-depth: nginx also rate-limits
 * /api/auth/login per IP, but the app must hold even when exposed without that proxy).
 *
 * Fixed windows in Redis keyed `rl:login:ip:<sha256(ip)[:24]>:<window>` so the limit holds
 * across api instances and the raw IP never lands in a Redis key. Combined with the per-account
 * lockout this also blunts lockout-DoS: an attacker cannot make enough attempts from one IP to
 * lock many accounts. Fails OPEN if Redis is unreachable (the per-account lockout still applies).
 */
@Injectable()
export class LoginRateLimiter {
  private readonly logger = new Logger(LoginRateLimiter.name);
  readonly limit: number;
  readonly windowSeconds: number;

  constructor(
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.limit = config.LOGIN_RATE_LIMIT;
    this.windowSeconds = config.LOGIN_RATE_WINDOW_S;
  }

  async hit(ip: string | null, nowMs = Date.now()): Promise<LoginRateDecision> {
    // No resolvable client IP (e.g. internal call): nothing to key on, so do not throttle.
    if (!ip) return { allowed: true, limit: this.limit, retryAfterSeconds: 0 };
    const window = Math.floor(nowMs / 1000 / this.windowSeconds);
    const bucket = createHash('sha256').update(ip).digest('hex').slice(0, 24);
    try {
      const count = Number(await this.redis.client.eval(WINDOW_LUA, 1, `rl:login:ip:${bucket}:${window}`, this.windowSeconds));
      const allowed = count <= this.limit;
      const retryAfterSeconds = allowed ? 0 : (window + 1) * this.windowSeconds - Math.floor(nowMs / 1000);
      return { allowed, limit: this.limit, retryAfterSeconds: Math.max(1, retryAfterSeconds) };
    } catch (e) {
      this.logger.warn(`login rate limiter unavailable, allowing attempt: ${(e as Error).message}`);
      return { allowed: true, limit: this.limit, retryAfterSeconds: 0 };
    }
  }
}
