import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { currentAuth } from '../common/context';
import { AppError } from '../common/errors';
import { Pagination, offsetOf, page } from '../common/pagination';
import { DbService } from '../db/db.service';
import type { ContentStatus } from '../db/types';
import { InvalidationService } from '../redis/redis.module';
import { ScopeService, type ScopedOrg } from '../tenancy/scope.service';

/**
 * Per-client content pre-approval allow-list. A client (or its reseller, on its
 * behalf) submits message content → PENDING; only a SUPER_ADMIN approves or
 * rejects. When organizations.content_approval_required is on, the engine lets
 * the client send only APPROVED content (policy.CheckApprovedContent).
 *
 * Unlike sender IDs (reviewed by the direct parent), content is reviewed only by
 * SUPER_ADMIN — so a reseller submitting for its client still yields PENDING.
 */
@Injectable()
export class ApprovedContentService {
  constructor(
    private readonly db: DbService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly invalidation: InvalidationService,
  ) {}

  /**
   * `include_children=true` with no org_id: the review queue. SUPER_ADMIN sees every org's
   * content; a RESELLER sees its direct clients'. Otherwise the resolved org's own rows.
   */
  async list(q: Pagination & { org_id?: string; status?: ContentStatus; include_children?: boolean }) {
    const auth = currentAuth();
    const queue = q.include_children && !q.org_id && auth.role !== 'CLIENT';
    const org = queue ? null : await this.scope.resolve(q.org_id, 'read');
    return this.db.tenant(async (trx) => {
      let base = trx.selectFrom('approved_content as ac').innerJoin('organizations as o', 'o.id', 'ac.org_id');
      if (queue) {
        // Admin: all orgs (RLS lets admin see everything). Reseller: its direct children only.
        if (auth.role !== 'SUPER_ADMIN') base = base.where('o.parent_id', '=', auth.orgId);
      } else {
        base = base.where('ac.org_id', '=', (org as { id: string }).id);
      }
      if (q.status) base = base.where('ac.status', '=', q.status);
      const [{ total }] = await base.select((eb) => eb.fn.countAll<number>().as('total')).execute();
      const rows = await base
        .selectAll('ac')
        .select(['o.name as org_name'])
        .orderBy('ac.created_at', 'desc')
        .limit(q.page_size)
        .offset(offsetOf(q))
        .execute();
      return page(rows, total, q);
    });
  }

  /**
   * Submitted by a SUPER_ADMIN -> APPROVED at once (and the admin may target ANY org, e.g. set a
   * client's allowed content directly); by the org or its reseller -> PENDING.
   */
  async create(orgIdParam: string | undefined, input: { content: string }) {
    const auth = currentAuth();
    let org: ScopedOrg;
    if (auth.role === 'SUPER_ADMIN') {
      // Admin can set content for any client/reseller (scope.resolve 'write' is read-only on clients).
      if (!orgIdParam) throw AppError.invalid('org_id is required', { field: 'org_id' });
      const found = await this.scope.findVisibleOrg(orgIdParam);
      if (!found) throw AppError.notFound('Organization');
      org = found;
    } else {
      org = await this.scope.resolve(orgIdParam, 'write');
    }
    if (org.role === 'SUPER_ADMIN') throw AppError.invalid('Content approval applies to resellers and clients');
    const content = input.content.trim();
    if (content.length === 0) throw AppError.invalid('Content is required', { field: 'content' });
    const byAdmin = auth.role === 'SUPER_ADMIN';
    return this.db.tenant(async (trx) => {
      const existing = await trx
        .selectFrom('approved_content')
        .select('id')
        .where('org_id', '=', org.id)
        .where('content', '=', content)
        .executeTakeFirst();
      if (existing) throw AppError.conflict('This content is already submitted for this organization');
      const row = await trx
        .insertInto('approved_content')
        .values({
          org_id: org.id,
          content,
          status: byAdmin ? 'APPROVED' : 'PENDING',
          reviewed_by: byAdmin ? auth.userId : null,
          reviewed_at: byAdmin ? new Date() : null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record({ action: 'approved_content.create', entityType: 'approved_content', entityId: row.id, targetOrgId: org.id, after: row });
      await this.invalidation.invalidate('approved_content', row.id);
      return row;
    });
  }

  /** The org may withdraw its own PENDING content; APPROVED/REJECTED rows only a SUPER_ADMIN. */
  async remove(id: string) {
    const auth = currentAuth();
    return this.db.tenant(async (trx) => {
      const row = await trx.selectFrom('approved_content').selectAll().where('id', '=', id).executeTakeFirst();
      if (!row) throw AppError.notFound('Content');
      await this.scope.assertOrgAccess(row.org_id, 'write');
      if (row.status !== 'PENDING' && auth.role !== 'SUPER_ADMIN') {
        throw AppError.forbidden('Reviewed content can only be removed by an administrator');
      }
      await trx.deleteFrom('approved_content').where('id', '=', id).execute();
      await this.audit.record({ action: 'approved_content.delete', entityType: 'approved_content', entityId: id, targetOrgId: row.org_id, before: row });
      await this.invalidation.invalidate('approved_content', id);
      return { ok: true };
    });
  }

  /** Only a SUPER_ADMIN may approve or reject content (per the feature spec). */
  async review(id: string, status: 'APPROVED' | 'REJECTED') {
    const auth = currentAuth();
    if (auth.role !== 'SUPER_ADMIN') throw AppError.forbidden('Only an administrator may review content');
    return this.db.tenant(async (trx) => {
      const before = await trx.selectFrom('approved_content').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!before) throw AppError.notFound('Content');
      const after = await trx
        .updateTable('approved_content')
        .set({ status, reviewed_by: auth.userId, reviewed_at: new Date() })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record({
        action: status === 'APPROVED' ? 'approved_content.approve' : 'approved_content.reject',
        entityType: 'approved_content',
        entityId: id,
        targetOrgId: before.org_id,
        before,
        after,
      });
      await this.invalidation.invalidate('approved_content', id);
      return after;
    });
  }
}
