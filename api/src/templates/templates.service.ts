import { Injectable } from '@nestjs/common';
import { Transaction, sql } from 'kysely';
import { AuditService } from '../audit/audit.service';
import { currentAuth } from '../common/context';
import { AppError } from '../common/errors';
import { Pagination, offsetOf, page } from '../common/pagination';
import { DbService } from '../db/db.service';
import type { DB, RouteTemplate, TemplateFallback } from '../db/types';
import { EngineClient } from '../engine/engine-client.service';
import type { EngineTemplateInline, EngineTemplatePreviewRequest } from '../engine/engine.types';
import { InvalidationService } from '../redis/redis.module';
import { ScopeService, canAccessOrg, isParentOf } from '../tenancy/scope.service';

export interface TemplateInput {
  route_id: string;
  org_id?: string | null;
  name: string;
  extract_patterns?: string[];
  otp_min_len?: number;
  otp_max_len?: number;
  template_body: string;
  default_body?: string | null;
  fallback_action?: TemplateFallback | null;
  brand?: string | null;
  is_active?: boolean;
}

export interface TemplateListQuery extends Pagination {
  route_id?: string;
  org_id?: string;
}

/**
 * Permissions (CONTRACTS §10): admin writes route-wide templates (org_id NULL); a reseller
 * writes per-client overrides for its clients; a client reads its effective templates.
 */
@Injectable()
export class TemplatesService {
  constructor(
    private readonly db: DbService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly invalidation: InvalidationService,
    private readonly engine: EngineClient,
  ) {}

  async list(q: TemplateListQuery) {
    const auth = currentAuth();
    if (q.org_id) await this.scope.resolve(q.org_id, 'read');
    if (auth.role === 'CLIENT') return this.effectiveForClient(auth.orgId, q);

    return this.db.tenant(async (trx) => {
      let base = trx.selectFrom('route_templates as t').innerJoin('routes as r', 'r.id', 't.route_id');
      if (auth.role === 'RESELLER') {
        // Route-wide defaults of the reseller's own routes, plus overrides of its clients (RLS).
        base = base.where((eb) =>
          eb.or([
            eb('t.org_id', 'is not', null),
            eb.exists(
              eb
                .selectFrom('org_route_assignments as a')
                .select('a.id')
                .whereRef('a.route_id', '=', 't.route_id')
                .where('a.org_id', '=', auth.orgId),
            ),
          ]),
        );
      }
      if (q.route_id) base = base.where('t.route_id', '=', q.route_id);
      if (q.org_id) base = base.where('t.org_id', '=', q.org_id);
      const [{ total }] = await base.select((eb) => eb.fn.countAll<number>().as('total')).execute();
      const rows = await base
        .selectAll('t')
        .select('r.name as route_name')
        .orderBy('r.name')
        .orderBy(sql`t.org_id nulls first`)
        .orderBy('t.created_at', 'desc')
        .limit(q.page_size)
        .offset(offsetOf(q))
        .execute();
      return page(rows, total, q);
    });
  }

  /** Per assigned route: the client's active override, else the active route-wide template. */
  private effectiveForClient(clientId: string, q: TemplateListQuery) {
    return this.db.tenant(async (trx) => {
      let routes = trx
        .selectFrom('org_route_assignments as a')
        .innerJoin('routes as r', 'r.id', 'a.route_id')
        .select(['r.id', 'r.name'])
        .distinct()
        .where('a.org_id', '=', clientId)
        .where('a.enabled', '=', true);
      if (q.route_id) routes = routes.where('r.id', '=', q.route_id);
      const assigned = await routes.execute();
      if (assigned.length === 0) return page([], 0, q);
      const templates = await trx
        .selectFrom('route_templates')
        .selectAll()
        .where('route_id', 'in', assigned.map((r) => r.id))
        .where('is_active', '=', true)
        .where((eb) => eb.or([eb('org_id', 'is', null), eb('org_id', '=', clientId)]))
        .execute();
      const items = assigned
        .map((r) => {
          const t = templates.find((x) => x.route_id === r.id && x.org_id === clientId) ?? templates.find((x) => x.route_id === r.id && x.org_id === null);
          return t ? { ...t, route_name: r.name, effective: true } : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort((a, b) => a.route_name.localeCompare(b.route_name));
      const start = offsetOf(q);
      return page(items.slice(start, start + q.page_size), items.length, q);
    });
  }

  async get(id: string) {
    const auth = currentAuth();
    return this.db.tenant(async (trx) => {
      const t = await this.findVisible(trx, id);
      if (auth.role === 'CLIENT' && t.org_id !== null && t.org_id !== auth.orgId) throw AppError.notFound('Template');
      return t;
    });
  }

  async create(input: TemplateInput) {
    const auth = currentAuth();
    const orgId = input.org_id ?? null;
    validateTemplateShape(input);
    return this.db.tenant(async (trx) => {
      const route = await trx.selectFrom('routes').select(['id']).where('id', '=', input.route_id).executeTakeFirst();
      if (!route) throw AppError.invalid('Unknown route_id', { field: 'route_id' });
      await this.assertWritable(trx, orgId, input.route_id);
      if (orgId === null && auth.role !== 'SUPER_ADMIN') throw AppError.forbidden('Only the admin may create route-wide templates');
      const t = await trx
        .insertInto('route_templates')
        .values({ ...input, org_id: orgId })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record({ action: 'template.create', entityType: 'route_template', entityId: t.id, targetOrgId: orgId, after: t });
      await this.invalidation.invalidate('route_templates', t.id);
      return t;
    });
  }

  async update(id: string, input: Partial<Omit<TemplateInput, 'route_id' | 'org_id'>>) {
    if (Object.keys(input).length === 0) throw AppError.invalid('Nothing to update');
    return this.db.tenant(async (trx) => {
      const before = await this.findVisible(trx, id);
      await this.assertWritable(trx, before.org_id, before.route_id);
      validateTemplateShape({ ...before, ...input });
      const after = await trx.updateTable('route_templates').set(input).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.record({ action: 'template.update', entityType: 'route_template', entityId: id, targetOrgId: after.org_id, before, after });
      await this.invalidation.invalidate('route_templates', id);
      return after;
    });
  }

  async remove(id: string) {
    return this.db.tenant(async (trx) => {
      const before = await this.findVisible(trx, id);
      await this.assertWritable(trx, before.org_id, before.route_id);
      await trx.deleteFrom('route_templates').where('id', '=', id).execute();
      await this.audit.record({ action: 'template.delete', entityType: 'route_template', entityId: id, targetOrgId: before.org_id, before });
      await this.invalidation.invalidate('route_templates', id);
      return { ok: true };
    });
  }

  /** Proxies POST /internal/v1/template/preview. Clients always preview their own effective template. */
  async preview(body: { text: string; route_id?: string; org_id?: string; template?: EngineTemplateInline }) {
    const auth = currentAuth();
    const req: EngineTemplatePreviewRequest = { text: body.text };
    if (body.template) {
      validateTemplateShape({ ...body.template, fallback_action: body.template.fallback_action as TemplateFallback | null });
      req.template = body.template;
    }
    if (body.route_id) {
      req.route_id = body.route_id;
      const orgId = auth.role === 'CLIENT' ? auth.orgId : body.org_id;
      if (orgId) {
        await this.scope.resolve(orgId, 'read');
        req.org_id = orgId;
      }
      if (auth.role !== 'SUPER_ADMIN') {
        const visible = await this.db.tenant((trx) => trx.selectFrom('routes').select('id').where('id', '=', body.route_id as string).executeTakeFirst());
        if (!visible) throw AppError.notFound('Route');
      }
    }
    if (!req.template && !req.route_id) throw AppError.invalid('Provide either template or route_id');
    return this.engine.templatePreview(req);
  }

  private async findVisible(trx: Transaction<DB>, id: string): Promise<RouteTemplate> {
    const auth = currentAuth();
    const t = await trx.selectFrom('route_templates').selectAll().where('id', '=', id).executeTakeFirst();
    if (!t) throw AppError.notFound('Template');
    if (auth.role !== 'SUPER_ADMIN' && t.org_id === null) {
      // Route-wide templates are readable only for routes visible (assigned) to the caller.
      const route = await trx.selectFrom('routes').select('id').where('id', '=', t.route_id).executeTakeFirst();
      if (!route) throw AppError.notFound('Template');
    }
    return t;
  }

  /** org_id NULL: admin only. org_id set: the reseller of that client (admin is read-only on clients). */
  private async assertWritable(trx: Transaction<DB>, orgId: string | null, routeId: string): Promise<void> {
    const auth = currentAuth();
    if (orgId === null) {
      if (auth.role !== 'SUPER_ADMIN') throw AppError.forbidden('Only the admin may modify route-wide templates');
      return;
    }
    const org = await this.scope.findVisibleOrg(orgId);
    if (!org) throw AppError.forbidden('You may not modify this organization');
    if (org.role !== 'CLIENT') throw AppError.invalid('Template overrides are per client (org_id must be a CLIENT)');
    if (!isParentOf(auth, org) || !canAccessOrg(auth, org, 'write')) throw AppError.forbidden('Only the client’s reseller may manage its template overrides');
    const assigned = await trx
      .selectFrom('org_route_assignments')
      .select('id')
      .where('route_id', '=', routeId)
      .where('org_id', 'in', [orgId, auth.orgId])
      .executeTakeFirst();
    if (!assigned) throw AppError.invalid('Route is not assigned to this client or to you', { field: 'route_id' });
  }
}

function validateTemplateShape(t: {
  template_body?: string;
  default_body?: string | null;
  fallback_action?: TemplateFallback | null;
  otp_min_len?: number;
  otp_max_len?: number;
}): void {
  if (t.template_body !== undefined && !t.template_body.includes('{otp}')) {
    throw AppError.invalid('template_body must contain {otp}', { field: 'template_body' });
  }
  if (t.fallback_action === 'SEND_DEFAULT_TEMPLATE' && !t.default_body) {
    throw AppError.invalid('default_body is required when fallback_action is SEND_DEFAULT_TEMPLATE', { field: 'default_body' });
  }
  if (t.otp_min_len !== undefined && t.otp_max_len !== undefined && t.otp_max_len < t.otp_min_len) {
    throw AppError.invalid('otp_max_len must be >= otp_min_len', { field: 'otp_max_len' });
  }
}
