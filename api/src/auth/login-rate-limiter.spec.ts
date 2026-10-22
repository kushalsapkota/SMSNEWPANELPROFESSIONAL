import { LoginRateLimiter } from './login-rate-limiter.service';
import { RedisService } from '../redis/redis.module';
import type { AppConfig } from '../config/config';

/**
 * Fake Redis that implements just enough of INCR+EXPIRE for the limiter's Lua:
 * it counts per key. `fail` makes eval throw to exercise the fail-open path.
 */
class FakeRedis {
  counts = new Map<string, number>();
  fail = false;
  client = {
    eval: async (_lua: string, _numKeys: number, key: string, _ttl: string) => {
      if (this.fail) throw new Error('redis down');
      const n = (this.counts.get(key) ?? 0) + 1;
      this.counts.set(key, n);
      return n;
    },
  };
}

function make(limit: number, windowSeconds = 60) {
  const redis = new FakeRedis();
  const config = { LOGIN_RATE_LIMIT: limit, LOGIN_RATE_WINDOW_S: windowSeconds } as AppConfig;
  const limiter = new LoginRateLimiter(redis as unknown as RedisService, config);
  return { redis, limiter };
}

describe('LoginRateLimiter', () => {
  const ip = '198.51.100.7';
  const now = 1_700_000_000_000; // fixed so the window index is stable

  it('allows up to the limit, then rejects within the same window', async () => {
    const { limiter } = make(3);
    for (let i = 1; i <= 3; i++) {
      expect((await limiter.hit(ip, now)).allowed).toBe(true);
    }
    const blocked = await limiter.hit(ip, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.limit).toBe(3);
    // retry_after points at the next window boundary and is never below 1s.
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('counts each IP in its own bucket and never stores the raw IP in the key', async () => {
    const { redis, limiter } = make(1);
    expect((await limiter.hit('203.0.113.1', now)).allowed).toBe(true);
    expect((await limiter.hit('203.0.113.2', now)).allowed).toBe(true); // different IP, own bucket
    expect((await limiter.hit('203.0.113.1', now)).allowed).toBe(false); // first IP now over
    for (const key of redis.counts.keys()) {
      expect(key).toMatch(/^rl:login:ip:[0-9a-f]{24}:\d+$/);
      expect(key).not.toContain('203.0.113');
    }
  });

  it('rolls over into a fresh count in the next window', async () => {
    const { limiter } = make(1);
    expect((await limiter.hit(ip, now)).allowed).toBe(true);
    expect((await limiter.hit(ip, now)).allowed).toBe(false);
    const next = now + 60_000; // one full window later
    expect((await limiter.hit(ip, next)).allowed).toBe(true);
  });

  it('does not throttle when there is no resolvable client IP', async () => {
    const { redis, limiter } = make(1);
    for (let i = 0; i < 5; i++) expect((await limiter.hit(null, now)).allowed).toBe(true);
    expect(redis.counts.size).toBe(0);
  });

  it('fails open when Redis is unreachable', async () => {
    const { redis, limiter } = make(1);
    redis.fail = true;
    const d = await limiter.hit(ip, now);
    expect(d.allowed).toBe(true);
    expect(d.retryAfterSeconds).toBe(0);
  });
});
