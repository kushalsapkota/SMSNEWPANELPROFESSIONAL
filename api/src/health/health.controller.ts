import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { sql } from 'kysely';
import { NoRequestTransaction, Public } from '../common/decorators';
import { DbService } from '../db/db.service';
import { EngineClient } from '../engine/engine-client.service';
import { RedisService } from '../redis/redis.module';

async function probe(fn: () => Promise<unknown>, timeoutMs = 2000): Promise<boolean> {
  try {
    await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs).unref())]);
    return true;
  } catch {
    return false;
  }
}

@Controller('api/health')
export class HealthController {
  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly engine: EngineClient,
  ) {}

  /** 200 when the api's own dependencies (DB pools, Redis) are up; engine status is informational. */
  @Get()
  @Public()
  @NoRequestTransaction()
  async health(@Res({ passthrough: true }) res: Response) {
    const [db, dbPrivileged, redis, engine] = await Promise.all([
      probe(() => sql`select 1`.execute(this.db.tenantDb)),
      probe(() => sql`select 1`.execute(this.db.privileged)),
      probe(() => this.redis.client.ping()),
      probe(async () => {
        const h = await this.engine.health();
        if (!h.ok) throw new Error('engine not ok');
      }),
    ]);
    const ok = db && dbPrivileged && redis;
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { ok, db: db && dbPrivileged, redis, engine };
  }
}
