import { Global, Inject, Injectable, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
import { DbService } from '../db/db.service';

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: true, lazyConnect: false });
    this.client.on('error', (e) => new Logger('Redis').warn(e.message));
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }
}

/** CONTRACTS §6 table names the engine understands. */
export type InvalidationEntity =
  | 'organizations'
  | 'routes'
  | 'route_connections'
  | 'upstream_connections'
  | 'upstream_rates'
  | 'route_templates'
  | 'org_route_assignments'
  | 'sender_ids'
  | 'approved_content'
  | 'smpp_accounts'
  | 'ip_whitelists'
  | 'webhooks'
  | 'blocked_numbers'
  | 'blocked_keywords'
  | 'accounts_balance';

/**
 * Publishes `{"entity","id"}` on `cfg:invalidate` AFTER the current tenant transaction
 * commits (so the engine never reloads uncommitted state). `id` null = reload the entity.
 */
@Injectable()
export class InvalidationService {
  private readonly logger = new Logger(InvalidationService.name);
  private readonly channel: string;

  constructor(
    private readonly redis: RedisService,
    private readonly db: DbService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.channel = config.CFG_INVALIDATE_CHANNEL;
  }

  async invalidate(entity: InvalidationEntity, id: string | null): Promise<void> {
    await this.db.afterCommit(() => this.publishNow(entity, id));
  }

  async publishNow(entity: InvalidationEntity, id: string | null): Promise<void> {
    try {
      await this.redis.client.publish(this.channel, JSON.stringify({ entity, id }));
    } catch (e) {
      // The engine does a full reload every 60s, so a lost message only delays propagation.
      this.logger.warn(`cfg:invalidate publish failed for ${entity}/${id}: ${(e as Error).message}`);
    }
  }
}

@Global()
@Module({ providers: [RedisService, InvalidationService], exports: [RedisService, InvalidationService] })
export class RedisModule {}
