import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
import { RedisService } from '../redis/redis.module';

/** INCR + EXPIRE in one round trip; returns the count in the current 1s window. */
const WINDOW_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
return c`;

export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
}

/**
 * Per-API-key limit for /v1 (CONTRACTS §11: 100 req/s). Fixed one-second windows in Redis
 * (`rl:apikey:<key_id>:<unix_sec>`, TTL 2s) so the limit holds across api instances.
 * Fails open if Redis is unreachable: the engine's per-org TPS limit still protects upstreams.
 */
@Injectable()
export class ApiRateLimiter {
  private readonly logger = new Logger(ApiRateLimiter.name);
  readonly limit: number;

  constructor(
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.limit = config.PUBLIC_API_RATE_LIMIT;
  }

  async hit(keyId: string, nowMs = Date.now()): Promise<RateDecision> {
    const sec = Math.floor(nowMs / 1000);
    try {
      const count = Number(await this.redis.client.eval(WINDOW_LUA, 1, `rl:apikey:${keyId}:${sec}`, 2));
      return { allowed: count <= this.limit, limit: this.limit, remaining: Math.max(0, this.limit - count) };
    } catch (e) {
      this.logger.warn(`rate limiter unavailable, allowing request: ${(e as Error).message}`);
      return { allowed: true, limit: this.limit, remaining: this.limit };
    }
  }
}
