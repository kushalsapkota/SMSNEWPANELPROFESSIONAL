import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { currentAuth, currentMeta } from '../common/context';
import { AppError } from '../common/errors';
import { Pagination, offsetOf, page } from '../common/pagination';
import { DbService } from '../db/db.service';
import type { IpScope } from '../db/types';
import { InvalidationService } from '../redis/redis.module';
import { ScopeService, isParentActor } from '../tenancy/scope.service';
import { cidrContains, parseCidr } from './cidr';

@Injectable()
export class IpWhitelistService {
  constructor(
    private readonly db: DbService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly invalidation: InvalidationService,
  ) {}

  async list(q: Pagination & { org_id?: string; scope?: IpScope }) {
    const org = await this.scope.resolve(q.org_id, 'read');
    return this.db.tenant(async (trx) => {
      let base = trx.selectFrom('ip_whitelists').where('org_id', '=', org.id);
      if (q.scope) base = base.where('scope', '=', q.scope);
      const [{ total }] = await base.select((eb) => eb.fn.countAll<number>().as('total')).execute();
      const rows = await base.selectAll().orderBy('created_at', 'desc').limit(q.page_size).offset(offsetOf(q)).execute();
      return page(rows, total, q);
    });
  }

  async create(orgIdParam: string | undefined, input: { cidr: string; scope: IpScope; note?: string | null }) {
    const auth = currentAuth();
    const org = await this.scope.resolve(orgIdParam, 'write');
    const parsed = parseCidr(input.cidr);
    if ('error' in parsed) throw AppError.invalid(`cidr: ${parsed.error}`, { field: 'cidr' });

    return this.db.tenant(async (trx) => {
      // Rules are an allow-list (any matching row admits the IP), so a rule the org adds itself
      // next to its parent's rules would widen what the parent restricted. While the parent has
      // rules covering a scope (that scope or ALL; any scope for an ALL rule), only the parent
      // may add rules for it.
      if (!isParentActor(auth, org)) {
        const covering: IpScope[] = input.scope === 'ALL' ? ['API', 'SMPP', 'PANEL', 'ALL'] : [input.scope, 'ALL'];
        const parentRule = await trx
          .selectFrom('ip_whitelists')
          .select(['id', 'scope'])
          .where('org_id', '=', org.id)
          .where('scope', 'in', covering)
          .where('created_by_org_id', 'is not', null)
          .where('created_by_org_id', '<>', org.id)
          .executeTakeFirst();
        if (parentRule) {
          throw AppError.forbidden(`Your parent organization restricts ${parentRule.scope} access; ask it to change the IP whitelist`);
        }
      }
      // Don't let a user lock themselves out of the panel with their first PANEL/ALL rule.
      const ip = currentMeta().ip;
      if (ip && org.id === auth.orgId && !auth.impersonatorUserId && (input.scope === 'PANEL' || input.scope === 'ALL')) {
        const existing = await trx.selectFrom('ip_whitelists').select('cidr').where('org_id', '=', org.id).where('scope', 'in', ['PANEL', 'ALL']).execute();
        const allowed = [...existing.map((e) => e.cidr), parsed.cidr].some((c) => cidrContains(c, ip));
        if (!allowed) {
          throw AppError.invalid(`This rule would block your current IP (${ip}) from the panel; add a rule covering it first`, { field: 'cidr', current_ip: ip });
        }
      }
      const row = await trx
        .insertInto('ip_whitelists')
        .values({
          org_id: org.id,
          cidr: parsed.cidr,
          scope: input.scope,
          note: input.note ?? null,
          created_by_user_id: auth.userId,
          created_by_org_id: auth.originalOrgId ?? auth.orgId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record({ action: 'ip_whitelist.create', entityType: 'ip_whitelist', entityId: row.id, targetOrgId: org.id, after: row });
      await this.invalidation.invalidate('ip_whitelists', row.id);
      return row;
    });
  }

  /** A rule the parent put on this org can only be removed by that parent (also while impersonating). */
  async remove(id: string) {
    const auth = currentAuth();
    return this.db.tenant(async (trx) => {
      const row = await trx.selectFrom('ip_whitelists').selectAll().where('id', '=', id).executeTakeFirst();
      if (!row) throw AppError.notFound('IP whitelist entry');
      const org = await this.scope.assertOrgAccess(row.org_id, 'write');
      if (row.created_by_org_id && row.created_by_org_id !== row.org_id && !isParentActor(auth, org)) {
        throw AppError.forbidden('This rule was added by your parent organization and can only be removed by it');
      }
      await trx.deleteFrom('ip_whitelists').where('id', '=', id).execute();
      await this.audit.record({ action: 'ip_whitelist.delete', entityType: 'ip_whitelist', entityId: id, targetOrgId: row.org_id, before: row });
      await this.invalidation.invalidate('ip_whitelists', id);
      return { ok: true };
    });
  }
}
