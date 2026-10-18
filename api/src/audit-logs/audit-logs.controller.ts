import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { z } from 'zod';
import { Pagination, offsetOf, page, paginationSchema } from '../common/pagination';
import { uuid } from '../common/validation';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.service';
import { ScopeService } from '../tenancy/scope.service';
import { currentAuth } from '../common/context';
import { AppError } from '../common/errors';

const listSchema = paginationSchema.extend({
  org_id: uuid.optional(),
  /** exact action, or a prefix ending in '*' (e.g. `client.*`) */
  action: z
    .string()
    .trim()
    .max(100)
    .regex(/^[a-z_.]+\*?$/, 'letters, dots, underscores; optional trailing *')
    .optional(),
  entity_type: z.string().trim().max(64).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});
type ListQuery = z.infer<typeof listSchema>;

@Injectable()
export class AuditLogsService {
  constructor(
    private readonly db: DbService,
    private readonly scope: ScopeService,
  ) {}

  /** RLS limits rows to what the caller may see; `org_id` narrows to rows targeting/acted by that org. */
  async list(q: ListQuery & Pagination) {
    const auth = currentAuth();
    if (auth.role === 'CLIENT' && q.org_id && q.org_id !== auth.orgId) throw AppError.forbidden();
    if (q.org_id) await this.scope.resolve(q.org_id, 'read');
    return this.db.tenant(async (trx) => {
      let base = trx.selectFrom('audit_logs');
      if (q.org_id) {
        const id = q.org_id;
        base = base.where((eb) => eb.or([eb('target_org_id', '=', id), eb('actor_org_id', '=', id)]));
      }
      if (q.action) base = q.action.endsWith('*') ? base.where('action', 'like', `${q.action.slice(0, -1).replace(/_/g, '\\_')}%`) : base.where('action', '=', q.action);
      if (q.entity_type) base = base.where('entity_type', '=', q.entity_type);
      if (q.from) base = base.where('created_at', '>=', new Date(q.from));
      if (q.to) base = base.where('created_at', '<', new Date(q.to));
      const [{ total }] = await base.select((eb) => eb.fn.countAll<number>().as('total')).execute();
      const rows = await base.selectAll().orderBy('created_at', 'desc').orderBy('id', 'desc').limit(q.page_size).offset(offsetOf(q)).execute();
      return page(await this.withNames(rows), total, q);
    });
  }

  /**
   * Display names for the rows the caller may already see (RLS above): actor / impersonator
   * emails and actor / target org names. Looked up with the privileged pool because RLS hides
   * the parent (e.g. a client can't read its reseller's users and org row), but only for ids
   * that appear on visible rows.
   */
  private async withNames<T extends { actor_user_id: string | null; impersonator_user_id: string | null; actor_org_id: string | null; target_org_id: string | null }>(rows: T[]) {
    const userIds = [...new Set(rows.flatMap((r) => [r.actor_user_id, r.impersonator_user_id]).filter((v): v is string => !!v))];
    const orgIds = [...new Set(rows.flatMap((r) => [r.actor_org_id, r.target_org_id]).filter((v): v is string => !!v))];
    const [users, orgs] = await Promise.all([
      userIds.length ? this.db.privileged.selectFrom('users').select(['id', 'email']).where('id', 'in', userIds).execute() : [],
      orgIds.length ? this.db.privileged.selectFrom('organizations').select(['id', 'name']).where('id', 'in', orgIds).execute() : [],
    ]);
    const email = new Map(users.map((u) => [u.id, u.email]));
    const name = new Map(orgs.map((o) => [o.id, o.name]));
    const get = (m: Map<string, string>, id: string | null) => (id ? m.get(id) ?? null : null);
    return rows.map((r) => ({
      ...r,
      actor_email: get(email, r.actor_user_id),
      impersonator_email: get(email, r.impersonator_user_id),
      actor_org_name: get(name, r.actor_org_id),
      target_org_name: get(name, r.target_org_id),
    }));
  }
}

@Controller('api/audit-logs')
export class AuditLogsController {
  constructor(private readonly logs: AuditLogsService) {}

  @Get()
  list(@Query(new ZodPipe(listSchema)) q: ListQuery) {
    return this.logs.list(q);
  }
}
