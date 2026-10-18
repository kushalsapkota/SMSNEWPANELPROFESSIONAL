import { Controller, Get, Injectable, Logger, Module } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { sql } from 'kysely';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AnalyticsService } from '../analytics/analytics.service';
import { BalanceModule } from '../balance/balance.module';
import { BalanceService } from '../balance/balance.service';
import { currentAuth } from '../common/context';
import { NoRequestTransaction } from '../common/decorators';
import { DbService } from '../db/db.service';
import { EngineClient } from '../engine/engine-client.service';
import { isConnectionUp } from '../engine/engine.types';

/**
 * CONTRACTS §10 GET /api/dashboard (role-appropriate):
 *   balance  live (engine) with snapshot fallback; null for SUPER_ADMIN (never billed)
 *   today / last7d  from message_stats_hourly, calendar days in the acting org's timezone,
 *            money per role as in /api/analytics
 *   counts   admin: resellers, clients, routes, connections_total, connections_up (engine; null if unreachable)
 *            reseller: clients, routes (assigned); client: routes (assigned), api_keys, campaigns_active
 */
@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly db: DbService,
    private readonly analytics: AnalyticsService,
    private readonly balance: BalanceService,
    private readonly engine: EngineClient,
  ) {}

  async get() {
    const auth = currentAuth();
    const from = await this.db.tenant(async (trx) => {
      const org = await trx.selectFrom('organizations').select('timezone').where('id', '=', auth.orgId).executeTakeFirst();
      const tz = org?.timezone ?? 'UTC';
      const ok = (await sql<{ ok: boolean }>`select exists (select 1 from pg_timezone_names where name = ${tz}) as ok`.execute(trx)).rows[0].ok;
      const zone = ok ? tz : 'UTC';
      return (await sql<{ t: Date }>`select (date_trunc('day', now() at time zone ${zone}) - interval '6 days') at time zone ${zone} as t`.execute(trx)).rows[0].t;
    });
    const series = await this.analytics.timeseries({ from, to: new Date(), granularity: 'day' });
    const last7d = series.points.map((p) => ({
      date: p.date,
      messages: p.messages,
      delivered: p.delivered,
      failed: p.failed,
      ...(auth.role === 'CLIENT' ? { spend_micros: p.cost_micros } : { revenue_micros: p.revenue_micros, cost_micros: p.cost_micros }),
    }));
    const todayPoint = last7d[last7d.length - 1] ?? { messages: 0, delivered: 0, failed: 0 };

    let balance: Awaited<ReturnType<BalanceService['get']>> | null = null;
    if (auth.role !== 'SUPER_ADMIN') {
      balance = await this.balance.get(auth.orgId).catch((e) => {
        this.logger.warn(`dashboard balance for ${auth.orgId} unavailable: ${(e as Error).message}`);
        return null;
      });
    }

    return {
      balance,
      today: { messages: todayPoint.messages, delivered: todayPoint.delivered, failed: todayPoint.failed },
      last7d,
      counts: await this.counts(),
      timezone: series.timezone,
    };
  }

  private async counts(): Promise<Record<string, number | null>> {
    const auth = currentAuth();
    const n = (v: { n: number } | undefined) => Number(v?.n ?? 0);
    if (auth.role === 'SUPER_ADMIN') {
      const c = await this.db.tenant(async (trx) => ({
        resellers: n(await trx.selectFrom('organizations').select((eb) => eb.fn.countAll<number>().as('n')).where('role', '=', 'RESELLER').executeTakeFirst()),
        clients: n(await trx.selectFrom('organizations').select((eb) => eb.fn.countAll<number>().as('n')).where('role', '=', 'CLIENT').executeTakeFirst()),
        routes: n(await trx.selectFrom('routes').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst()),
        connections_total: n(await trx.selectFrom('upstream_connections').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst()),
      }));
      const up = await this.engine
        .connectionsStatus()
        .then((conns) => conns.filter(isConnectionUp).length)
        .catch(() => null);
      return { ...c, connections_up: up };
    }
    return this.db.tenant(async (trx) => {
      const routes = n(
        await trx
          .selectFrom('org_route_assignments')
          .select(sql<number>`count(distinct route_id)`.as('n'))
          .where('org_id', '=', auth.orgId)
          .where('enabled', '=', true)
          .executeTakeFirst(),
      );
      if (auth.role === 'RESELLER') {
        const clients = n(
          await trx.selectFrom('organizations').select((eb) => eb.fn.countAll<number>().as('n')).where('parent_id', '=', auth.orgId).executeTakeFirst(),
        );
        const r: Record<string, number | null> = { clients, routes };
        return r;
      }
      const apiKeys = n(
        await trx
          .selectFrom('api_keys')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('org_id', '=', auth.orgId)
          .where('revoked_at', 'is', null)
          .executeTakeFirst(),
      );
      const campaigns = n(
        await trx
          .selectFrom('campaigns')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('org_id', '=', auth.orgId)
          .where('status', 'in', ['RUNNING', 'SCHEDULED'])
          .executeTakeFirst(),
      );
      const r: Record<string, number | null> = { routes, api_keys: apiKeys, campaigns_active: campaigns };
      return r;
    });
  }
}

@ApiTags('dashboard')
@Controller('api/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /** Several short transactions + an engine call: no request-wide transaction. */
  @Get()
  @NoRequestTransaction()
  get() {
    return this.dashboard.get();
  }
}

@Module({ imports: [AnalyticsModule, BalanceModule], controllers: [DashboardController], providers: [DashboardService] })
export class DashboardModule {}
