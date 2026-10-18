import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service';
import { currentAuth } from '../common/context';
import { AppError } from '../common/errors';
import { DbService } from '../db/db.service';
import { InvalidationService } from '../redis/redis.module';
import { ScopeService } from '../tenancy/scope.service';

export interface AssignmentInput {
  route_id: string;
  prefix: string;
  rate_micros: number;
  priority: number;
  enabled: boolean;
}

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly db: DbService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly invalidation: InvalidationService,
  ) {}

  /**
   * Assignments of org `id` with the parent's rate for the same route (longest parent prefix
   * covering the assignment prefix). parent_rate_micros is only shown to the parent / admin.
   */
  async list(orgId: string) {
    const auth = currentAuth();
    const org = await this.scope.getOrg(orgId, 'read');
    const showParent = org.role === 'CLIENT' && org.id !== auth.orgId && org.parent_id !== null;
    return this.db.tenant(async (trx) => {
      const rows = await trx
        .selectFrom('org_route_assignments as a')
        .innerJoin('routes as r', 'r.id', 'a.route_id')
        .select([
          'a.id',
          'a.route_id',
          'r.name as route_name',
          'r.template_mode',
          'r.enabled as route_enabled',
          'a.prefix',
          'a.rate_micros',
          'a.priority',
          'a.enabled',
          'a.created_at',
          'a.updated_at',
        ])
        .select((eb) =>
          (showParent
            ? eb
                .selectFrom('org_route_assignments as p')
                .select('p.rate_micros')
                .where('p.org_id', '=', org.parent_id as string)
                .whereRef('p.route_id', '=', 'a.route_id')
                .where('p.enabled', '=', true)
                .where(sql<boolean>`starts_with(a.prefix, p.prefix)`)
                .orderBy(sql`length(p.prefix)`, 'desc')
                .limit(1)
            : sql<number | null>`null::bigint`
          ).as('parent_rate_micros'),
        )
        .where('a.org_id', '=', orgId)
        .orderBy('r.name')
        .orderBy('a.prefix')
        .execute();
      return { items: rows.map((r) => ({ ...r, parent_rate_micros: r.parent_rate_micros === null ? null : Number(r.parent_rate_micros) })) };
    });
  }

  /** Replace org `id`'s assignment set. Only the direct parent may do this. */
  async replace(orgId: string, items: AssignmentInput[]) {
    const auth = currentAuth();
    const org = await this.scope.requireChild(orgId);
    const keys = items.map((i) => `${i.route_id}|${i.prefix}`);
    const dupe = keys.find((k, i) => keys.indexOf(k) !== i);
    if (dupe) throw AppError.invalid('Duplicate (route_id, prefix) pair', { route_id: dupe.split('|')[0], prefix: dupe.split('|')[1] });
    const routeIds = [...new Set(items.map((i) => i.route_id))];

    return this.db.tenant(async (trx) => {
      if (routeIds.length && org.role === 'RESELLER') {
        const routes = await trx.selectFrom('routes').select('id').where('id', 'in', routeIds).execute();
        const missing = routeIds.filter((id) => !routes.some((r) => r.id === id));
        if (missing.length) throw AppError.invalid('Unknown route_id', { route_ids: missing });
      }
      if (org.role === 'CLIENT') {
        // A reseller can only hand out routes the admin gave it, and only within its prefixes.
        const own = await trx
          .selectFrom('org_route_assignments')
          .select(['route_id', 'prefix'])
          .where('org_id', '=', auth.orgId)
          .where('enabled', '=', true)
          .execute();
        for (const it of items) {
          const mine = own.filter((o) => o.route_id === it.route_id);
          if (mine.length === 0) {
            throw new AppError('FORBIDDEN', 'Route is not assigned to your organization', { route_id: it.route_id });
          }
          if (it.enabled && !mine.some((o) => it.prefix.startsWith(o.prefix))) {
            throw AppError.invalid('Prefix is outside the prefixes assigned to you for this route', {
              route_id: it.route_id,
              prefix: it.prefix,
              allowed_prefixes: mine.map((o) => o.prefix),
            });
          }
        }
      }

      const before = await trx.selectFrom('org_route_assignments').selectAll().where('org_id', '=', orgId).execute();
      const wanted = new Set(keys);
      const toDelete = before.filter((b) => !wanted.has(`${b.route_id}|${b.prefix}`)).map((b) => b.id);
      if (toDelete.length) await trx.deleteFrom('org_route_assignments').where('id', 'in', toDelete).execute();
      if (items.length) {
        await trx
          .insertInto('org_route_assignments')
          .values(items.map((i) => ({ org_id: orgId, route_id: i.route_id, prefix: i.prefix, rate_micros: i.rate_micros, priority: i.priority, enabled: i.enabled })))
          .onConflict((oc) =>
            oc.columns(['org_id', 'route_id', 'prefix']).doUpdateSet((eb) => ({
              rate_micros: eb.ref('excluded.rate_micros'),
              priority: eb.ref('excluded.priority'),
              enabled: eb.ref('excluded.enabled'),
            })),
          )
          .execute();
      }
      const after = await trx.selectFrom('org_route_assignments').selectAll().where('org_id', '=', orgId).execute();
      await this.audit.record({ action: 'route.assign', entityType: 'org_route_assignments', entityId: orgId, targetOrgId: orgId, before, after });
      await this.invalidation.invalidate('org_route_assignments', null);
      return this.list(orgId);
    });
  }
}
