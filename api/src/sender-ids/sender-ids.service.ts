import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { currentAuth } from '../common/context';
import { AppError } from '../common/errors';
import { Pagination, offsetOf, page } from '../common/pagination';
import { DbService } from '../db/db.service';
import type { SenderStatus } from '../db/types';
import { InvalidationService } from '../redis/redis.module';
import { ScopeService, isParentActor, isParentOf } from '../tenancy/scope.service';

@Injectable()
export class SenderIdsService {
  constructor(
    private readonly db: DbService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly invalidation: InvalidationService,
  ) {}

  /**
   * `include_children=true` (admin/reseller, no org_id): rows of every direct child org —
   * the parent's approval queue. Otherwise the rows of the resolved org.
   */
  async list(q: Pagination & { org_id?: string; status?: SenderStatus; include_children?: boolean }) {
    const auth = currentAuth();
    const children = q.include_children && !q.org_id && auth.role !== 'CLIENT';
    const org = children ? null : await this.scope.resolve(q.org_id, 'read');
    return this.db.tenant(async (trx) => {
      let base = trx.selectFrom('sender_ids as s').innerJoin('organizations as o', 'o.id', 's.org_id').leftJoin('routes as r', 'r.id', 's.route_id');
      base = children ? base.where('o.parent_id', '=', auth.orgId) : base.where('s.org_id', '=', (org as { id: string }).id);
      if (q.status) base = base.where('s.status', '=', q.status);
      const [{ total }] = await base.select((eb) => eb.fn.countAll<number>().as('total')).execute();
      const rows = await base
        .selectAll('s')
        .select(['o.name as org_name', 'r.name as route_name'])
        .orderBy('s.created_at', 'desc')
        .limit(q.page_size)
        .offset(offsetOf(q))
        .execute();
      return page(rows, total, q);
    });
  }

  /** Created by the org itself -> PENDING; created by its parent (also while impersonating) -> APPROVED immediately. */
  async create(orgIdParam: string | undefined, input: { sender: string; route_id?: string | null }) {
    const auth = currentAuth();
    const org = await this.scope.resolve(orgIdParam, 'write');
    if (org.role === 'SUPER_ADMIN') throw AppError.invalid('Sender IDs apply to resellers and clients');
    const sender = /^\+?[0-9]+$/.test(input.sender) ? input.sender.replace(/^\+/, '') : input.sender;
    const byParent = isParentActor(auth, org);
    return this.db.tenant(async (trx) => {
      if (input.route_id) {
        const assigned = await trx
          .selectFrom('org_route_assignments')
          .select('id')
          .where('org_id', '=', org.id)
          .where('route_id', '=', input.route_id)
          .executeTakeFirst();
        if (!assigned) throw AppError.invalid('Route is not assigned to this organization', { field: 'route_id' });
      }
      const row = await trx
        .insertInto('sender_ids')
        .values({
          org_id: org.id,
          route_id: input.route_id ?? null,
          sender,
          status: byParent ? 'APPROVED' : 'PENDING',
          reviewed_by: byParent ? auth.userId : null,
          reviewed_at: byParent ? new Date() : null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record({ action: 'sender_id.create', entityType: 'sender_id', entityId: row.id, targetOrgId: org.id, after: row });
      await this.invalidation.invalidate('sender_ids', row.id);
      return row;
    });
  }

  /**
   * The org itself may withdraw only its own PENDING requests. Reviewed rows (approved or
   * rejected by the parent, or created by it) are the parent's control — and any row makes the
   * org sender-restricted in the engine — so only the parent (also while impersonating) removes them.
   */
  async remove(id: string) {
    const auth = currentAuth();
    return this.db.tenant(async (trx) => {
      const row = await trx.selectFrom('sender_ids').selectAll().where('id', '=', id).executeTakeFirst();
      if (!row) throw AppError.notFound('Sender ID');
      const org = await this.scope.assertOrgAccess(row.org_id, 'write');
      if (row.status !== 'PENDING' && !isParentActor(auth, org)) {
        throw AppError.forbidden('Reviewed sender IDs can only be removed by your parent organization');
      }
      await trx.deleteFrom('sender_ids').where('id', '=', id).execute();
      await this.audit.record({ action: 'sender_id.delete', entityType: 'sender_id', entityId: id, targetOrgId: row.org_id, before: row });
      await this.invalidation.invalidate('sender_ids', id);
      return { ok: true };
    });
  }

  /** Only the parent of the sender's org may review it. */
  async review(id: string, status: 'APPROVED' | 'REJECTED') {
    const auth = currentAuth();
    return this.db.tenant(async (trx) => {
      const before = await trx.selectFrom('sender_ids').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!before) throw AppError.notFound('Sender ID');
      const org = await this.scope.findVisibleOrg(before.org_id);
      if (!org || !isParentOf(auth, org)) throw AppError.forbidden('Only the parent organization may review sender IDs');
      const after = await trx
        .updateTable('sender_ids')
        .set({ status, reviewed_by: auth.userId, reviewed_at: new Date() })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record({ action: status === 'APPROVED' ? 'sender_id.approve' : 'sender_id.reject', entityType: 'sender_id', entityId: id, targetOrgId: before.org_id, before, after });
      await this.invalidation.invalidate('sender_ids', id);
      return after;
    });
  }
}
