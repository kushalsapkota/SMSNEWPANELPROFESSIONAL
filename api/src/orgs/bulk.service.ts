import { Inject, Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { currentAuth } from '../common/context';
import { AppError } from '../common/errors';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
import { CryptoService } from '../crypto/crypto.service';
import { DbService } from '../db/db.service';
import type { BillingMode, BindType } from '../db/types';
import { InvalidationService } from '../redis/redis.module';

export interface BulkClientRow {
  reseller_id: string;
  name: string;
  email?: string;
  password?: string;
  billing_mode: BillingMode;
  credit_limit_micros: number;
  smpp_system_id?: string;
  smpp_password?: string;
  max_binds: number;
  max_tps: number | null;
  allowed_bind_types: BindType[];
  // Optional: assign the new client to this route at `rate_micros` (prefix '' = all, priority 1,
  // enabled). Admin-direct — the client's rate overrides the parent's for its own billing.
  route_id?: string | null;
  rate_micros?: number | null;
}

export interface BulkCreateInput {
  clients: BulkClientRow[];
}

export interface BulkResultRow {
  index: number;
  name: string;
  status: 'created' | 'error';
  org_id?: string;
  reseller_id?: string;
  reseller_name?: string;
  email?: string;
  password?: string;
  billing_mode?: BillingMode;
  credit_limit_micros?: number;
  smpp_system_id?: string;
  smpp_password?: string;
  route_id?: string;
  route_name?: string;
  rate_micros?: number;
  error?: string;
}

// Unambiguous alphabet (no O/0, I/l/1) for generated passwords the admin will read off a screen.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function gen(len: number): string {
  const b = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}

/**
 * Admin-only bulk provisioning of CLIENT orgs under chosen resellers. Each row creates the org,
 * its login user, balance (billing + credit limit), notification settings and an SMPP account, in
 * one transaction. Rows are independent: a failure (e.g. duplicate email or system_id) is reported
 * for that row and the rest still run. Generated passwords are returned once, in the response.
 */
@Injectable()
export class BulkService {
  private readonly emailDomain: string;

  constructor(
    private readonly db: DbService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly invalidation: InvalidationService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.emailDomain = config.CLIENT_EMAIL_DOMAIN;
  }

  private deriveEmail(name: string): string {
    const local = name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40) || 'client';
    return `${local}@${this.emailDomain}`;
  }

  async create(input: BulkCreateInput) {
    const auth = currentAuth();
    if (auth.role !== 'SUPER_ADMIN') throw AppError.forbidden('Only administrators can bulk-create clients');

    // Resolve every referenced reseller + route once (admin can see all under RLS).
    const resellerIds = [...new Set(input.clients.map((c) => c.reseller_id))];
    const routeIds = [...new Set(input.clients.map((c) => c.route_id).filter((v): v is string => !!v))];
    const [resellers, routes] = await this.db.tenant(async (trx) => [
      await trx.selectFrom('organizations').select(['id', 'name', 'role', 'status']).where('id', 'in', resellerIds).execute(),
      routeIds.length ? await trx.selectFrom('routes').select(['id', 'name']).where('id', 'in', routeIds).execute() : [],
    ]);
    const byId = new Map(resellers.map((r) => [r.id, r]));
    const routeById = new Map(routes.map((r) => [r.id, r]));

    const seenEmail = new Set<string>();
    const seenSys = new Set<string>();
    const results: BulkResultRow[] = [];

    for (let i = 0; i < input.clients.length; i++) {
      const row = input.clients[i];
      const res: BulkResultRow = { index: i, name: row.name, status: 'error' };
      try {
        const reseller = byId.get(row.reseller_id);
        if (!reseller) throw AppError.invalid('reseller not found');
        if (reseller.role !== 'RESELLER') throw AppError.invalid('selected parent is not a reseller');
        if (reseller.status === 'CLOSED') throw AppError.invalid('reseller is closed');
        if (row.billing_mode === 'PREPAID' && row.credit_limit_micros !== 0) {
          throw AppError.invalid('credit limit must be 0 for PREPAID');
        }
        const route = row.route_id ? routeById.get(row.route_id) : undefined;
        if (row.route_id && !route) throw AppError.invalid('route not found');

        const email = (row.email && row.email.trim().toLowerCase()) || this.deriveEmail(row.name);
        const systemId = (row.smpp_system_id && row.smpp_system_id.trim()) || row.name.trim();
        if (seenEmail.has(email)) throw AppError.invalid(`duplicate login email in this batch: ${email}`);
        if (seenSys.has(systemId.toLowerCase())) throw AppError.invalid(`duplicate SMPP system_id in this batch: ${systemId}`);
        seenEmail.add(email);
        seenSys.add(systemId.toLowerCase());

        const panelPw = row.password || gen(16);
        const smppPw = row.smpp_password || gen(8);
        const orgId = await this.createOne(row, reseller.name, email, systemId, panelPw, smppPw);

        res.status = 'created';
        res.org_id = orgId;
        res.reseller_id = row.reseller_id;
        res.reseller_name = reseller.name;
        res.email = email;
        res.password = panelPw;
        res.billing_mode = row.billing_mode;
        res.credit_limit_micros = row.credit_limit_micros;
        res.smpp_system_id = systemId;
        res.smpp_password = smppPw;
        if (route) {
          res.route_id = route.id;
          res.route_name = route.name;
          res.rate_micros = row.rate_micros ?? 0;
        }
      } catch (e) {
        res.error = this.friendlyError(e);
      }
      results.push(res);
    }

    return {
      created: results.filter((r) => r.status === 'created').length,
      failed: results.filter((r) => r.status === 'error').length,
      results,
    };
  }

  private async createOne(
    row: BulkClientRow,
    resellerName: string,
    email: string,
    systemId: string,
    panelPw: string,
    smppPw: string,
  ): Promise<string> {
    const panelHash = await this.crypto.hashPassword(panelPw);
    const smppHash = await this.crypto.hashPassword(smppPw);
    const smppEnc = this.crypto.encrypt(smppPw);
    // id generated up front: RLS hides a freshly inserted org from INSERT ... RETURNING until the
    // next statement (can_see_org resolves it by parent_id). Same pattern as OrgsService.create.
    const orgId = randomUUID();
    const smppId = randomUUID();

    await this.db.tenant(async (trx) => {
      await trx.insertInto('organizations').values({ id: orgId, role: 'CLIENT', parent_id: row.reseller_id, name: row.name }).execute();
      await trx.insertInto('users').values({ org_id: orgId, email, password_hash: panelHash }).execute();
      await trx
        .insertInto('accounts_balance')
        .values({ org_id: orgId, billing_mode: row.billing_mode, credit_limit_micros: row.credit_limit_micros, currency: 'USD' })
        .execute();
      await trx.insertInto('notification_settings').values({ org_id: orgId, email_to: [email] }).execute();
      await trx
        .insertInto('smpp_accounts')
        .values({
          id: smppId,
          org_id: orgId,
          system_id: systemId,
          password_hash: smppHash,
          password_enc: smppEnc,
          max_binds: row.max_binds,
          max_tps: row.max_tps,
          allowed_bind_types: row.allowed_bind_types,
          enabled: true,
          locked_by_parent: true,
        })
        .execute();
      if (row.route_id) {
        // Admin-direct assignment: catch-all prefix, priority 1, enabled, at the client's own rate.
        await trx
          .insertInto('org_route_assignments')
          .values({ org_id: orgId, route_id: row.route_id, prefix: '', rate_micros: row.rate_micros ?? 0, priority: 1, enabled: true })
          .execute();
      }
      await this.audit.record({
        action: 'client.bulk_create',
        entityType: 'organization',
        entityId: orgId,
        targetOrgId: orgId,
        after: { name: row.name, reseller: resellerName, reseller_id: row.reseller_id, email, billing_mode: row.billing_mode, credit_limit_micros: row.credit_limit_micros, system_id: systemId, route_id: row.route_id ?? null, rate_micros: row.route_id ? (row.rate_micros ?? 0) : null },
      });
    });

    await this.invalidation.invalidate('organizations', orgId);
    await this.invalidation.invalidate('accounts_balance', orgId);
    await this.invalidation.invalidate('smpp_accounts', smppId);
    if (row.route_id) await this.invalidation.invalidate('org_route_assignments', null);
    return orgId;
  }

  private friendlyError(e: unknown): string {
    if (e instanceof AppError) return e.message;
    const msg = (e as { message?: string; constraint?: string; detail?: string })?.message ?? 'failed';
    const detail = (e as { detail?: string })?.detail ?? '';
    if (/unique|duplicate/i.test(msg) || /already exists/i.test(detail)) {
      if (/email|users_/i.test(msg + detail)) return 'a user with this login email already exists';
      if (/system_id|smpp/i.test(msg + detail)) return 'this SMPP system_id is already taken';
      return 'already exists (duplicate)';
    }
    return msg;
  }
}
