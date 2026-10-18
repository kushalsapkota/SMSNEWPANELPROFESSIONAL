import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service';
import { currentAuth } from '../common/context';
import { AppError } from '../common/errors';
import { Pagination, offsetOf, page } from '../common/pagination';
import { likeContains } from '../common/validation';
import { DbService } from '../db/db.service';
import type { TemplateFallback } from '../db/types';
import { InvalidationService } from '../redis/redis.module';

export interface RouteInput {
  name: string;
  description?: string | null;
  enabled?: boolean;
  template_mode?: boolean;
  template_fallback?: TemplateFallback;
  force_sender_id?: string | null;
}

export interface RouteConnectionInput {
  connection_id: string;
  priority?: number;
  weight?: number;
  enabled?: boolean;
}

@Injectable()
export class RoutesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly invalidation: InvalidationService,
  ) {}

  /** Admin: all routes. Others: routes assigned (enabled) to the acting org — id, name, template_mode only. */
  list(q: Pagination & { q?: string; enabled?: boolean }) {
    const auth = currentAuth();
    return this.db.tenant(async (trx) => {
      if (auth.role !== 'SUPER_ADMIN') {
        let base = trx
          .selectFrom('routes as r')
          .where((eb) =>
            eb.exists(
              eb
                .selectFrom('org_route_assignments as a')
                .select('a.id')
                .whereRef('a.route_id', '=', 'r.id')
                .where('a.org_id', '=', auth.orgId)
                .where('a.enabled', '=', true),
            ),
          );
        if (q.q) base = base.where('r.name', 'ilike', likeContains(q.q));
        const [{ total }] = await base.select((eb) => eb.fn.countAll<number>().as('total')).execute();
        const items = await base.select(['r.id', 'r.name', 'r.template_mode']).orderBy('r.name').limit(q.page_size).offset(offsetOf(q)).execute();
        return page(items, total, q);
      }
      let base = trx.selectFrom('routes as r');
      if (q.q) base = base.where('r.name', 'ilike', likeContains(q.q));
      if (q.enabled !== undefined) base = base.where('r.enabled', '=', q.enabled);
      const [{ total }] = await base.select((eb) => eb.fn.countAll<number>().as('total')).execute();
      const items = await base
        .selectAll('r')
        .select((eb) => [
          eb.selectFrom('route_connections as rc').whereRef('rc.route_id', '=', 'r.id').select((e) => e.fn.countAll<number>().as('n')).as('connection_count'),
          eb
            .selectFrom('route_connections as rc')
            .whereRef('rc.route_id', '=', 'r.id')
            .where('rc.enabled', '=', true)
            .select((e) => e.fn.countAll<number>().as('n'))
            .as('enabled_connection_count'),
          eb
            .selectFrom('org_route_assignments as a')
            .whereRef('a.route_id', '=', 'r.id')
            .select(sql<number>`count(distinct a.org_id)`.as('n'))
            .as('assigned_org_count'),
        ])
        .orderBy('r.name')
        .limit(q.page_size)
        .offset(offsetOf(q))
        .execute();
      return page(
        items.map((r) => ({
          ...r,
          connection_count: Number(r.connection_count ?? 0),
          enabled_connection_count: Number(r.enabled_connection_count ?? 0),
          assigned_org_count: Number(r.assigned_org_count ?? 0),
        })),
        total,
        q,
      );
    });
  }

  get(id: string) {
    return this.db.tenant(async (trx) => {
      const route = await trx.selectFrom('routes').selectAll().where('id', '=', id).executeTakeFirst();
      if (!route) throw AppError.notFound('Route');
      return { ...route, connections: await this.connectionsOf(id) };
    });
  }

  private connectionsOf(routeId: string) {
    return this.db.tenant((trx) =>
      trx
        .selectFrom('route_connections as rc')
        .innerJoin('upstream_connections as c', 'c.id', 'rc.connection_id')
        .select(['rc.connection_id', 'c.name as connection_name', 'c.enabled as connection_enabled', 'rc.priority', 'rc.weight', 'rc.enabled'])
        .where('rc.route_id', '=', routeId)
        .orderBy('rc.priority')
        .orderBy('c.name')
        .execute(),
    );
  }

  create(input: RouteInput) {
    return this.db.tenant(async (trx) => {
      const route = await trx.insertInto('routes').values(input).returningAll().executeTakeFirstOrThrow();
      await this.audit.record({ action: 'route.create', entityType: 'route', entityId: route.id, after: route });
      await this.invalidation.invalidate('routes', route.id);
      return route;
    });
  }

  update(id: string, input: Partial<RouteInput>) {
    if (Object.keys(input).length === 0) throw AppError.invalid('Nothing to update');
    return this.db.tenant(async (trx) => {
      const before = await trx.selectFrom('routes').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!before) throw AppError.notFound('Route');
      const after = await trx.updateTable('routes').set(input).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.record({ action: 'route.update', entityType: 'route', entityId: id, before, after });
      await this.invalidation.invalidate('routes', id);
      return after;
    });
  }

  remove(id: string) {
    return this.db.tenant(async (trx) => {
      const before = await trx.selectFrom('routes').selectAll().where('id', '=', id).executeTakeFirst();
      if (!before) throw AppError.notFound('Route');
      await trx.deleteFrom('routes').where('id', '=', id).execute();
      await this.audit.record({ action: 'route.delete', entityType: 'route', entityId: id, before });
      await this.invalidation.invalidate('routes', id);
      await this.invalidation.invalidate('org_route_assignments', null);
      await this.invalidation.invalidate('route_connections', null);
      await this.invalidation.invalidate('route_templates', null);
      return { ok: true };
    });
  }

  /** Replace the route's connection set. */
  replaceConnections(routeId: string, items: RouteConnectionInput[]) {
    const ids = items.map((i) => i.connection_id);
    if (new Set(ids).size !== ids.length) throw AppError.invalid('Duplicate connection_id');
    return this.db.tenant(async (trx) => {
      const route = await trx.selectFrom('routes').select('id').where('id', '=', routeId).executeTakeFirst();
      if (!route) throw AppError.notFound('Route');
      if (ids.length) {
        const found = await trx.selectFrom('upstream_connections').select('id').where('id', 'in', ids).execute();
        const missing = ids.filter((i) => !found.some((f) => f.id === i));
        if (missing.length) throw AppError.invalid('Unknown connection_id', { connection_ids: missing });
      }
      const before = await trx.selectFrom('route_connections').selectAll().where('route_id', '=', routeId).execute();
      await trx.deleteFrom('route_connections').where('route_id', '=', routeId).execute();
      if (items.length) {
        await trx
          .insertInto('route_connections')
          .values(items.map((i) => ({ route_id: routeId, connection_id: i.connection_id, priority: i.priority, weight: i.weight, enabled: i.enabled })))
          .execute();
      }
      const after = await this.connectionsOf(routeId);
      await this.audit.record({ action: 'route.connections_replace', entityType: 'route', entityId: routeId, before, after });
      await this.invalidation.invalidate('route_connections', null);
      return { items: after };
    });
  }
}
