import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { currentAuth } from '../common/context';
import { AppError } from '../common/errors';
import { Pagination, offsetOf, page } from '../common/pagination';
import { likeContains } from '../common/validation';
import { DbService } from '../db/db.service';
import { InvalidationService } from '../redis/redis.module';
import { ScopeService, ScopedOrg, isParentActor } from '../tenancy/scope.service';

type Kind = 'numbers' | 'keywords';
const TABLE = { numbers: 'blocked_numbers', keywords: 'blocked_keywords' } as const;

/**
 * Blocklists. The admin acting on itself manages the GLOBAL list (org_id NULL); resellers'
 * rows apply to all of their clients; clients may keep their own.
 */
@Injectable()
export class BlocklistService {
  constructor(
    private readonly db: DbService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly invalidation: InvalidationService,
  ) {}

  private ownerOf(org: ScopedOrg): string | null {
    return org.role === 'SUPER_ADMIN' ? null : org.id;
  }

  /** The caller's real org (the parent while impersonating): recorded as the row's creator. */
  private creatorOrg(): string {
    const auth = currentAuth();
    return auth.originalOrgId ?? auth.orgId;
  }

  async list(kind: Kind, q: Pagination & { org_id?: string; q?: string }) {
    const org = await this.scope.resolve(q.org_id, 'read');
    const owner = this.ownerOf(org);
    return this.db.tenant(async (trx) => {
      if (kind === 'numbers') {
        let base = trx.selectFrom('blocked_numbers').where('org_id', owner === null ? 'is' : '=', owner);
        const digits = q.q?.replace(/[^0-9]/g, '');
        if (digits) base = base.where('prefix', 'like', `${digits}%`);
        const [{ total }] = await base.select((eb) => eb.fn.countAll<number>().as('total')).execute();
        const rows = await base.selectAll().orderBy('created_at', 'desc').limit(q.page_size).offset(offsetOf(q)).execute();
        return page(rows, total, q);
      }
      let base = trx.selectFrom('blocked_keywords').where('org_id', owner === null ? 'is' : '=', owner);
      if (q.q) base = base.where('pattern', 'ilike', likeContains(q.q));
      const [{ total }] = await base.select((eb) => eb.fn.countAll<number>().as('total')).execute();
      const rows = await base.selectAll().orderBy('created_at', 'desc').limit(q.page_size).offset(offsetOf(q)).execute();
      return page(rows, total, q);
    });
  }

  async addNumber(orgIdParam: string | undefined, input: { prefix: string; note?: string | null }) {
    const org = await this.scope.resolve(orgIdParam, 'write');
    const prefix = input.prefix.replace(/[\s\-+().]/g, '');
    if (!/^[0-9]{1,15}$/.test(prefix)) throw AppError.invalid('prefix must be 1-15 digits (a full MSISDN blocks one number)', { field: 'prefix' });
    return this.db.tenant(async (trx) => {
      const row = await trx
        .insertInto('blocked_numbers')
        .values({ org_id: this.ownerOf(org), prefix, note: input.note ?? null, created_by_org_id: this.creatorOrg() })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record({ action: 'blocklist.number_add', entityType: 'blocked_number', entityId: row.id, targetOrgId: row.org_id, after: row });
      await this.invalidation.invalidate('blocked_numbers', row.id);
      return row;
    });
  }

  async addKeyword(orgIdParam: string | undefined, input: { pattern: string; note?: string | null }) {
    const org = await this.scope.resolve(orgIdParam, 'write');
    return this.db.tenant(async (trx) => {
      const row = await trx
        .insertInto('blocked_keywords')
        .values({ org_id: this.ownerOf(org), pattern: input.pattern, note: input.note ?? null, created_by_org_id: this.creatorOrg() })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record({ action: 'blocklist.keyword_add', entityType: 'blocked_keyword', entityId: row.id, targetOrgId: row.org_id, after: row });
      await this.invalidation.invalidate('blocked_keywords', row.id);
      return row;
    });
  }

  /** Global rows: admin only. Rows the parent added to an org: only that parent (also while impersonating). */
  async remove(kind: Kind, id: string) {
    const auth = currentAuth();
    return this.db.tenant(async (trx) => {
      const row =
        kind === 'numbers'
          ? await trx.selectFrom('blocked_numbers').selectAll().where('id', '=', id).executeTakeFirst()
          : await trx.selectFrom('blocked_keywords').selectAll().where('id', '=', id).executeTakeFirst();
      if (!row) throw AppError.notFound('Blocklist entry');
      if (row.org_id === null) {
        if (auth.role !== 'SUPER_ADMIN') throw AppError.forbidden('Global blocklist entries are managed by the admin');
      } else {
        const org = await this.scope.assertOrgAccess(row.org_id, 'write');
        // An entry the parent put on this org is the parent's control: the org can't remove it.
        if (row.created_by_org_id && row.created_by_org_id !== row.org_id && !isParentActor(auth, org)) {
          throw AppError.forbidden('This entry was added by your parent organization and can only be removed by it');
        }
      }
      if (kind === 'numbers') await trx.deleteFrom('blocked_numbers').where('id', '=', id).execute();
      else await trx.deleteFrom('blocked_keywords').where('id', '=', id).execute();
      await this.audit.record({
        action: kind === 'numbers' ? 'blocklist.number_remove' : 'blocklist.keyword_remove',
        entityType: kind === 'numbers' ? 'blocked_number' : 'blocked_keyword',
        entityId: id,
        targetOrgId: row.org_id,
        before: row,
      });
      await this.invalidation.invalidate(TABLE[kind], id);
      return { ok: true };
    });
  }
}
