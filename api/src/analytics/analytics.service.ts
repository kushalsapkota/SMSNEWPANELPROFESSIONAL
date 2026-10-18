import { Injectable } from '@nestjs/common';
import { RawBuilder, Transaction, sql } from 'kysely';
import { AuthContext, currentAuth } from '../common/context';
import { AppError } from '../common/errors';
import { DbService } from '../db/db.service';
import type { DB } from '../db/types';
import { OrgFilter, orgFilterConds, resolveOrgFilter } from '../messaging/org-filter';
import { ScopeService } from '../tenancy/scope.service';
import { EngineMetricsService } from './engine-metrics.service';
import { EngineClient } from '../engine/engine-client.service';

export interface StatsQuery {
  org_id?: string;
  route_id?: string;
  from: Date;
  to: Date;
}

export type Granularity = 'hour' | 'day';
export type BreakdownBy = 'route' | 'country' | 'org' | 'status';

/**
 * Role-correct money from message_stats_hourly (column comments in 002_message_logs.sql):
 *   SUPER_ADMIN  revenue = reseller_cost (what resellers pay), cost = route_cost (upstream)
 *   RESELLER     revenue = client_cost of its CLIENTS' traffic, cost = reseller_cost (what it pays the admin,
 *                incl. its own sends)
 *   CLIENT       spend only: cost = client_cost, revenue = profit = 0
 */
export function moneyExprs(auth: AuthContext): { revenue: RawBuilder<number>; cost: RawBuilder<number> } {
  if (auth.role === 'SUPER_ADMIN') {
    return { revenue: sql<number>`coalesce(sum(s.reseller_cost_micros), 0)::bigint`, cost: sql<number>`coalesce(sum(s.route_cost_micros), 0)::bigint` };
  }
  if (auth.role === 'RESELLER') {
    return {
      revenue: sql<number>`coalesce(sum(s.client_cost_micros) filter (where s.org_id <> ${auth.orgId}::uuid), 0)::bigint`,
      cost: sql<number>`coalesce(sum(s.reseller_cost_micros), 0)::bigint`,
    };
  }
  return { revenue: sql<number>`0::bigint`, cost: sql<number>`coalesce(sum(s.client_cost_micros), 0)::bigint` };
}

/** Final non-delivered outcomes. */
const FAILED_SUM = sql<number>`coalesce(sum(s.undelivered + s.failed + s.rejected + s.expired), 0)::bigint`;

export function rate(delivered: number, messages: number): number {
  return messages > 0 ? Math.round((delivered / messages) * 10_000) / 10_000 : 0;
}

const HOUR_MS = 3_600_000;

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly db: DbService,
    private readonly scope: ScopeService,
    private readonly engine: EngineClient,
    private readonly metrics: EngineMetricsService,
  ) {}

  private conds(f: OrgFilter, q: StatsQuery): RawBuilder<boolean>[] {
    const c = [...orgFilterConds(f, 's'), sql<boolean>`s.bucket >= date_trunc('hour', ${q.from}::timestamptz)`, sql<boolean>`s.bucket < ${q.to}::timestamptz`];
    if (q.route_id) c.push(sql<boolean>`s.route_id = ${q.route_id}::uuid`);
    return c;
  }

  async summary(q: StatsQuery) {
    const auth = currentAuth();
    const f = await resolveOrgFilter(this.scope, q.org_id);
    const m = moneyExprs(auth);
    const row = await this.db.tenant(async (trx) => {
      const r = await sql<{ messages: number; parts: number; delivered: number; failed: number; revenue: number; cost: number }>`
        select coalesce(sum(s.messages), 0)::bigint as messages,
               coalesce(sum(s.parts), 0)::bigint as parts,
               coalesce(sum(s.delivered), 0)::bigint as delivered,
               ${FAILED_SUM} as failed,
               ${m.revenue} as revenue,
               ${m.cost} as cost
          from message_stats_hourly s
         where ${sql.join(this.conds(f, q), sql` and `)}`.execute(trx);
      return r.rows[0];
    });
    const pending = Math.max(0, row.messages - row.delivered - row.failed);
    const client = auth.role === 'CLIENT';
    return {
      messages: row.messages,
      parts: row.parts,
      delivered: row.delivered,
      failed: row.failed,
      pending,
      delivery_rate: rate(row.delivered, row.messages),
      revenue_micros: row.revenue,
      cost_micros: row.cost,
      profit_micros: client ? 0 : row.revenue - row.cost,
      ...(client ? { spend_micros: row.cost } : {}),
      from: q.from,
      to: q.to,
    };
  }

  /**
   * hour: UTC hour buckets (as stored). day: calendar days in the org's timezone (`tz` param,
   * else the filtered org's / acting org's organizations.timezone; unknown zones → UTC).
   * Gaps are filled with zero points.
   */
  async timeseries(q: StatsQuery & { granularity: Granularity; tz?: string }) {
    const auth = currentAuth();
    const f = await resolveOrgFilter(this.scope, q.org_id);
    const span = q.to.getTime() - q.from.getTime();
    if (q.granularity === 'hour' && span > 31 * 24 * HOUR_MS) throw AppError.invalid('hourly timeseries cover at most 31 days', { max_days: 31 });
    const m = moneyExprs(auth);
    const client = auth.role === 'CLIENT';
    return this.db.tenant(async (trx) => {
      const tz = await this.timezone(trx, f, q.tz);
      const conds = sql.join(this.conds(f, q), sql` and `);
      const rows =
        q.granularity === 'hour'
          ? (
              await sql<SeriesRow>`
                with agg as (
                  select s.bucket as t, sum(s.messages)::bigint as messages, sum(s.delivered)::bigint as delivered,
                         ${FAILED_SUM} as failed, ${m.revenue} as revenue, ${m.cost} as cost
                    from message_stats_hourly s where ${conds} group by s.bucket)
                select g.t, to_char(g.t at time zone 'UTC', 'YYYY-MM-DD') as date,
                       coalesce(a.messages, 0)::bigint as messages, coalesce(a.delivered, 0)::bigint as delivered,
                       coalesce(a.failed, 0)::bigint as failed, coalesce(a.revenue, 0)::bigint as revenue, coalesce(a.cost, 0)::bigint as cost
                  from generate_series(date_trunc('hour', ${q.from}::timestamptz), ${q.to}::timestamptz - interval '1 microsecond', interval '1 hour') g(t)
                  left join agg a on a.t = g.t
                 order by g.t`.execute(trx)
            ).rows
          : (
              await sql<SeriesRow>`
                with agg as (
                  select date_trunc('day', s.bucket at time zone ${tz}) as d, sum(s.messages)::bigint as messages,
                         sum(s.delivered)::bigint as delivered, ${FAILED_SUM} as failed, ${m.revenue} as revenue, ${m.cost} as cost
                    from message_stats_hourly s where ${conds} group by 1)
                select (g.d at time zone ${tz}) as t, to_char(g.d, 'YYYY-MM-DD') as date,
                       coalesce(a.messages, 0)::bigint as messages, coalesce(a.delivered, 0)::bigint as delivered,
                       coalesce(a.failed, 0)::bigint as failed, coalesce(a.revenue, 0)::bigint as revenue, coalesce(a.cost, 0)::bigint as cost
                  from generate_series(date_trunc('day', ${q.from}::timestamptz at time zone ${tz}),
                                       (${q.to}::timestamptz - interval '1 microsecond') at time zone ${tz}, interval '1 day') g(d)
                  left join agg a on a.d = g.d
                 order by g.d`.execute(trx)
            ).rows;
      return {
        granularity: q.granularity,
        timezone: q.granularity === 'day' ? tz : 'UTC',
        points: rows.map((r) => ({
          t: r.t,
          date: r.date,
          messages: r.messages,
          delivered: r.delivered,
          failed: r.failed,
          revenue_micros: r.revenue,
          cost_micros: r.cost,
          ...(client ? { spend_micros: r.cost } : {}),
        })),
      };
    });
  }

  async breakdown(q: StatsQuery & { by: BreakdownBy }) {
    const auth = currentAuth();
    const f = await resolveOrgFilter(this.scope, q.org_id);
    const m = moneyExprs(auth);
    return this.db.tenant(async (trx) => {
      const conds = sql.join(this.conds(f, q), sql` and `);
      if (q.by === 'status') {
        const r = (
          await sql<{ messages: number; delivered: number; undelivered: number; failed: number; rejected: number; expired: number }>`
            select coalesce(sum(s.messages), 0)::bigint as messages, coalesce(sum(s.delivered), 0)::bigint as delivered,
                   coalesce(sum(s.undelivered), 0)::bigint as undelivered, coalesce(sum(s.failed), 0)::bigint as failed,
                   coalesce(sum(s.rejected), 0)::bigint as rejected, coalesce(sum(s.expired), 0)::bigint as expired
              from message_stats_hourly s where ${conds}`.execute(trx)
        ).rows[0];
        const finals = r.delivered + r.undelivered + r.failed + r.rejected + r.expired;
        const entries: [string, string, number][] = [
          ['DELIVERED', 'Delivered', r.delivered],
          ['UNDELIVERED', 'Undelivered', r.undelivered],
          ['FAILED', 'Failed', r.failed],
          ['REJECTED', 'Rejected', r.rejected],
          ['EXPIRED', 'Expired', r.expired],
          ['PENDING', 'Pending (no final status yet)', Math.max(0, r.messages - finals)],
        ];
        return {
          by: q.by,
          rows: entries
            .filter(([, , n]) => n > 0)
            .map(([key, label, n]) => ({
              key,
              label,
              messages: n,
              delivered: key === 'DELIVERED' ? n : 0,
              failed: key === 'DELIVERED' || key === 'PENDING' ? 0 : n,
              delivery_rate: key === 'DELIVERED' ? 1 : 0,
              share: rate(n, r.messages),
              // Money is not attributable per final status in the hourly rollups.
              revenue_micros: 0,
              cost_micros: 0,
            })),
        };
      }

      // Admin looking at everything: one row per reseller tree (resellers are what it manages).
      const orgKey = auth.role === 'SUPER_ADMIN' && f.kind === 'all' ? sql`coalesce(s.reseller_id, s.org_id)` : sql`s.org_id`;
      const key = q.by === 'route' ? sql`s.route_id::text` : q.by === 'country' ? sql`s.country_iso::text` : sql`(${orgKey})::text`;
      const rows = (
        await sql<{ key: string; messages: number; delivered: number; failed: number; revenue: number; cost: number }>`
          select ${key} as key, sum(s.messages)::bigint as messages, sum(s.delivered)::bigint as delivered,
                 ${FAILED_SUM} as failed, ${m.revenue} as revenue, ${m.cost} as cost
            from message_stats_hourly s where ${conds}
           group by 1 order by messages desc, key limit 500`.execute(trx)
      ).rows;
      const labels = await this.labels(trx, q.by, rows.map((r) => r.key));
      return {
        by: q.by,
        rows: rows.map((r) => ({
          key: r.key,
          label: labels.get(r.key) ?? (q.by === 'country' ? (r.key === '--' ? 'Unknown' : r.key) : r.key),
          messages: r.messages,
          delivered: r.delivered,
          failed: r.failed,
          delivery_rate: rate(r.delivered, r.messages),
          revenue_micros: r.revenue,
          cost_micros: r.cost,
          ...(auth.role === 'CLIENT' ? { spend_micros: r.cost } : { profit_micros: r.revenue - r.cost }),
        })),
      };
    });
  }

  /** CONTRACTS §10 /api/analytics/live (admin): engine connection status + submit-rate from engine metrics. */
  async live() {
    const conns = await this.engine.connectionsStatus();
    const tpsIn = await this.metrics.submitRate();
    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      tps_in: tpsIn === null ? null : round(tpsIn),
      tps_out: round(conns.reduce((a, c) => a + (Number(c.tps_current) || 0), 0)),
      queue_depth: conns.reduce((a, c) => a + (Number(c.queue_depth) || 0), 0),
      inflight: conns.reduce((a, c) => a + (Number(c.inflight) || 0), 0),
      connections_up: conns.filter((c) => c.state === 'BOUND').length,
      connections_total: conns.length,
      connections_enabled: conns.filter((c) => c.enabled).length,
    };
  }

  private async labels(trx: Transaction<DB>, by: BreakdownBy, keys: string[]): Promise<Map<string, string>> {
    const ids = keys.filter((k) => /^[0-9a-f-]{36}$/i.test(k));
    if (ids.length === 0 || by === 'country' || by === 'status') return new Map();
    const rows =
      by === 'route'
        ? await trx.selectFrom('routes').select(['id', 'name']).where('id', 'in', ids).execute()
        : await trx.selectFrom('organizations').select(['id', 'name']).where('id', 'in', ids).execute();
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /** Requested tz if valid, else the covered org's (or acting org's) timezone, else UTC. */
  private async timezone(trx: Transaction<DB>, f: OrgFilter, requested?: string): Promise<string> {
    const valid = async (tz: string | null | undefined): Promise<boolean> =>
      !!tz && (await sql<{ ok: boolean }>`select exists (select 1 from pg_timezone_names where name = ${tz}) as ok`.execute(trx)).rows[0].ok;
    if (requested) {
      if (!(await valid(requested))) throw AppError.invalid('tz is not a known IANA time zone', { field: 'tz' });
      return requested;
    }
    const orgId = f.kind === 'all' ? currentAuth().orgId : f.id;
    const org = await trx.selectFrom('organizations').select('timezone').where('id', '=', orgId).executeTakeFirst();
    return org && (await valid(org.timezone)) ? org.timezone : 'UTC';
  }
}

interface SeriesRow {
  t: Date;
  date: string;
  messages: number;
  delivered: number;
  failed: number;
  revenue: number;
  cost: number;
}
