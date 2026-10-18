import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service';
import { currentAuth } from '../common/context';
import { AppError } from '../common/errors';
import { Pagination, offsetOf, page } from '../common/pagination';
import { DbService } from '../db/db.service';
import type { CampaignStatus } from '../db/types';
import { ScopeService } from '../tenancy/scope.service';
import { RecipientImport, assertPlaceholders } from './recipients';

export interface CampaignInput {
  name: string;
  source_addr: string;
  body: string;
  scheduled_at?: string | null;
}

type CampaignRow = {
  id: string;
  org_id: string;
  name: string;
  source_addr: string;
  body: string;
  status: CampaignStatus;
  scheduled_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  total: number;
  submitted: number;
  failed: number;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export function campaignDto(c: CampaignRow, pending?: number) {
  return {
    id: c.id,
    org_id: c.org_id,
    name: c.name,
    source_addr: c.source_addr,
    body: c.body,
    status: c.status,
    scheduled_at: c.scheduled_at,
    started_at: c.started_at,
    finished_at: c.finished_at,
    total: c.total,
    submitted: c.submitted,
    failed: c.failed,
    ...(pending !== undefined ? { pending } : {}),
    created_by_user_id: c.created_by_user_id,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

const INSERT_BATCH = 5000;

/**
 * State machine (the worker moves SCHEDULED→RUNNING when due and RUNNING→COMPLETED/FAILED,
 * or →PAUSED on an org-level rejection such as INSUFFICIENT_FUNDS):
 *   start   DRAFT | SCHEDULED | PAUSED → RUNNING (now)
 *   pause   SCHEDULED | RUNNING        → PAUSED
 *   cancel  DRAFT | SCHEDULED | RUNNING | PAUSED → CANCELLED (unsent recipients stay unsent)
 * Transitions are single conditional UPDATEs, so they serialise with the worker's row lock.
 */
const TRANSITIONS: Record<'start' | 'pause' | 'cancel', { from: CampaignStatus[]; to: CampaignStatus }> = {
  start: { from: ['DRAFT', 'SCHEDULED', 'PAUSED'], to: 'RUNNING' },
  pause: { from: ['SCHEDULED', 'RUNNING'], to: 'PAUSED' },
  cancel: { from: ['DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED'], to: 'CANCELLED' },
};

@Injectable()
export class CampaignsService {
  constructor(
    private readonly db: DbService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
  ) {}

  /** Creates the campaign for the acting org with its recipients (one transaction). */
  async create(input: CampaignInput, imported: RecipientImport) {
    const auth = currentAuth();
    if (auth.role === 'SUPER_ADMIN') throw AppError.forbidden('Campaigns are sent by resellers and clients');
    if (imported.recipients.length === 0) {
      throw AppError.invalid('No valid recipients', { invalid_rows: imported.invalid_rows, duplicate_rows: imported.duplicate_rows, errors: imported.errors });
    }
    assertPlaceholders(input.body, imported.columns);
    const scheduledAt = input.scheduled_at ? new Date(input.scheduled_at) : null;

    return this.db.tenant(async (trx) => {
      const c = await trx
        .insertInto('campaigns')
        .values({
          org_id: auth.orgId,
          name: input.name,
          source_addr: input.source_addr,
          body: input.body,
          status: scheduledAt ? 'SCHEDULED' : 'DRAFT',
          scheduled_at: scheduledAt,
          total: imported.recipients.length,
          created_by_user_id: auth.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      for (let i = 0; i < imported.recipients.length; i += INSERT_BATCH) {
        const values = imported.recipients.slice(i, i + INSERT_BATCH).map((r, j) => ({
          campaign_id: c.id,
          seq: i + j + 1,
          destination: r.destination,
          vars: JSON.stringify(r.vars),
        }));
        await trx.insertInto('campaign_recipients').values(values).execute();
      }
      await this.audit.record({
        action: 'campaign.create',
        entityType: 'campaign',
        entityId: c.id,
        targetOrgId: auth.orgId,
        after: { ...campaignDto(c), invalid_rows: imported.invalid_rows, duplicate_rows: imported.duplicate_rows },
      });
      return {
        ...campaignDto(c, c.total),
        import: { columns: imported.columns, invalid_rows: imported.invalid_rows, duplicate_rows: imported.duplicate_rows, errors: imported.errors },
      };
    });
  }

  async list(q: Pagination & { org_id?: string; status?: CampaignStatus }) {
    const auth = currentAuth();
    // Default for a reseller: its own and its clients' campaigns (RLS-visible); ?org_id narrows to one org.
    const org = q.org_id ? await this.scope.resolve(q.org_id, 'read') : null;
    return this.db.tenant(async (trx) => {
      let base = trx.selectFrom('campaigns');
      if (org) base = base.where('org_id', '=', org.id);
      else if (auth.role === 'CLIENT') base = base.where('org_id', '=', auth.orgId);
      if (q.status) base = base.where('status', '=', q.status);
      const [{ total }] = await base.select((eb) => eb.fn.countAll<number>().as('total')).execute();
      const rows = await base.selectAll().orderBy('created_at', 'desc').orderBy('id').limit(q.page_size).offset(offsetOf(q)).execute();
      return page(rows.map((r) => campaignDto(r)), total, q);
    });
  }

  async get(id: string) {
    return this.db.tenant(async (trx) => {
      const c = await trx.selectFrom('campaigns').selectAll().where('id', '=', id).executeTakeFirst();
      if (!c) throw AppError.notFound('Campaign');
      await this.scope.assertOrgAccess(c.org_id, 'read');
      const { pending } = await trx
        .selectFrom('campaign_recipients')
        .select((eb) => eb.fn.countAll<number>().as('pending'))
        .where('campaign_id', '=', id)
        .where('message_id', 'is', null)
        .where('error_code', 'is', null)
        .executeTakeFirstOrThrow();
      return campaignDto(c, pending);
    });
  }

  async recipients(id: string, q: Pagination & { state?: 'pending' | 'submitted' | 'failed' }) {
    return this.db.tenant(async (trx) => {
      const c = await trx.selectFrom('campaigns').select(['id', 'org_id']).where('id', '=', id).executeTakeFirst();
      if (!c) throw AppError.notFound('Campaign');
      await this.scope.assertOrgAccess(c.org_id, 'read');
      let base = trx.selectFrom('campaign_recipients').where('campaign_id', '=', id);
      if (q.state === 'pending') base = base.where('message_id', 'is', null).where('error_code', 'is', null);
      if (q.state === 'submitted') base = base.where('message_id', 'is not', null);
      if (q.state === 'failed') base = base.where('error_code', 'is not', null);
      const [{ total }] = await base.select((eb) => eb.fn.countAll<number>().as('total')).execute();
      const rows = await base.select(['seq', 'destination', 'vars', 'message_id', 'error_code']).orderBy('seq').limit(q.page_size).offset(offsetOf(q)).execute();
      return page(rows, total, q);
    });
  }

  async transition(id: string, action: 'start' | 'pause' | 'cancel') {
    const t = TRANSITIONS[action];
    return this.db.tenant(async (trx) => {
      const before = await trx.selectFrom('campaigns').selectAll().where('id', '=', id).executeTakeFirst();
      if (!before) throw AppError.notFound('Campaign');
      await this.scope.assertOrgAccess(before.org_id, 'write');
      const after = await trx
        .updateTable('campaigns')
        .set({
          status: t.to,
          ...(action === 'start' ? { started_at: sql<Date>`coalesce(started_at, now())` } : {}),
          ...(action === 'cancel' ? { finished_at: sql<Date>`now()` } : {}),
        })
        .where('id', '=', id)
        .where('status', 'in', t.from)
        .returningAll()
        .executeTakeFirst();
      if (!after) {
        const cur = await trx.selectFrom('campaigns').select('status').where('id', '=', id).executeTakeFirstOrThrow();
        throw AppError.conflict(`Cannot ${action} a campaign that is ${cur.status}`, { status: cur.status, allowed_from: t.from });
      }
      await this.audit.record({ action: `campaign.${action}`, entityType: 'campaign', entityId: id, targetOrgId: before.org_id, before: campaignDto(before), after: campaignDto(after) });
      return campaignDto(after);
    });
  }
}
