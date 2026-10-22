import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Transaction, sql } from 'kysely';
import { AuditService } from '../audit/audit.service';
import { currentAuth } from '../common/context';
import { AppError } from '../common/errors';
import { Pagination, offsetOf, page } from '../common/pagination';
import { likeContains } from '../common/validation';
import { CryptoService } from '../crypto/crypto.service';
import { DbService } from '../db/db.service';
import type { DB, Organization, OrganizationUpdate, OrgRole, OrgStatus, BillingMode } from '../db/types';
import { EngineClient } from '../engine/engine-client.service';
import { InvalidationService } from '../redis/redis.module';
import { ScopeService, ScopedOrg, canAccessOrg, isParentOf } from '../tenancy/scope.service';
import { publicOrg, publicUser } from './org.dto';

export interface ListOrgsQuery extends Pagination {
  role?: 'RESELLER' | 'CLIENT';
  parent_id?: string;
  status?: OrgStatus;
  q?: string;
}

export interface CreateOrgInput {
  name: string;
  email: string;
  password: string;
  full_name?: string;
  brand_name?: string;
  max_tps?: number;
  daily_limit?: number | null;
  monthly_limit?: number | null;
  billing_mode?: BillingMode;
  credit_limit_micros?: number;
  currency?: string;
  timezone?: string;
}

export interface PatchOrgInput {
  name?: string;
  brand_name?: string | null;
  max_tps?: number;
  daily_limit?: number | null;
  monthly_limit?: number | null;
  timezone?: string;
  whitelabel_domain?: string | null;
}

/** Fields an org may change on itself; everything else is parent-controlled. */
const SELF_EDITABLE: (keyof PatchOrgInput)[] = ['brand_name', 'timezone', 'whitelabel_domain'];

export interface ChannelsInput {
  sending_enabled?: boolean;
  api_enabled?: boolean;
  smpp_enabled?: boolean;
  web_enabled?: boolean;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

@Injectable()
export class OrgsService {
  constructor(
    private readonly db: DbService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly invalidation: InvalidationService,
    private readonly engine: EngineClient,
  ) {}

  async list(q: ListOrgsQuery) {
    const auth = currentAuth();
    if (auth.role === 'CLIENT') throw AppError.forbidden('Clients have no child organizations');
    return this.db.tenant(async (trx) => {
      let base = trx
        .selectFrom('organizations as o')
        .leftJoin('accounts_balance as b', 'b.org_id', 'o.id')
        .where('o.role', '<>', 'SUPER_ADMIN');
      if (auth.role === 'RESELLER') {
        base = base.where('o.parent_id', '=', auth.orgId).where('o.role', '=', 'CLIENT');
      } else {
        const role: OrgRole = q.role ?? (q.parent_id ? 'CLIENT' : 'RESELLER');
        base = base.where('o.role', '=', role);
        if (q.parent_id) base = base.where('o.parent_id', '=', q.parent_id);
      }
      if (q.status) base = base.where('o.status', '=', q.status);
      if (q.q) {
        const like = likeContains(q.q);
        base = base.where((eb) => eb.or([eb('o.name', 'ilike', like), eb('o.brand_name', 'ilike', like), eb(sql<string>`o.id::text`, '=', q.q as string)]));
      }
      const [{ total }] = await base.select((eb) => eb.fn.countAll<number>().as('total')).execute();
      const rows = await base
        .selectAll('o')
        .select(['b.balance_micros', 'b.credit_limit_micros', 'b.billing_mode', 'b.currency'])
        .select((eb) =>
          eb
            .selectFrom('organizations as c')
            .whereRef('c.parent_id', '=', 'o.id')
            .select((e2) => e2.fn.countAll<number>().as('n'))
            .as('child_count'),
        )
        .orderBy('o.created_at', 'desc')
        .orderBy('o.id')
        .limit(q.page_size)
        .offset(offsetOf(q))
        .execute();
      const items = rows.map((r) => ({
        ...publicOrg(r as unknown as Organization),
        balance:
          r.balance_micros === null
            ? null
            : { balance_micros: r.balance_micros, credit_limit_micros: r.credit_limit_micros, billing_mode: r.billing_mode, currency: r.currency },
        child_count: Number(r.child_count ?? 0),
      }));
      return page(items, total, q);
    });
  }

  /** Creates a child of the acting org (admin -> RESELLER, reseller -> CLIENT) with owner user, balance and notification defaults. */
  async create(input: CreateOrgInput) {
    const auth = currentAuth();
    const childRole: OrgRole | null = auth.role === 'SUPER_ADMIN' ? 'RESELLER' : auth.role === 'RESELLER' ? 'CLIENT' : null;
    if (!childRole) throw AppError.forbidden('Clients cannot create organizations');
    const billingMode = input.billing_mode ?? 'PREPAID';
    const creditLimit = input.credit_limit_micros ?? 0;
    if (billingMode === 'PREPAID' && creditLimit !== 0) {
      throw AppError.invalid('credit_limit_micros must be 0 for PREPAID billing', { field: 'credit_limit_micros' });
    }
    const passwordHash = await this.crypto.hashPassword(input.password);
    // The id is generated here: RLS hides a freshly inserted org from INSERT ... RETURNING
    // until the next statement (can_see_org looks the row up by parent_id).
    const orgId = randomUUID();

    return this.db.tenant(async (trx) => {
      await trx
        .insertInto('organizations')
        .values({
          id: orgId,
          role: childRole,
          parent_id: auth.orgId,
          name: input.name,
          brand_name: input.brand_name ?? null,
          max_tps: input.max_tps,
          daily_limit: input.daily_limit ?? null,
          monthly_limit: input.monthly_limit ?? null,
          timezone: input.timezone,
        })
        .execute();
      const user = await trx
        .insertInto('users')
        .values({ org_id: orgId, email: input.email, password_hash: passwordHash, full_name: input.full_name ?? null })
        .returningAll()
        .executeTakeFirstOrThrow();
      const balance = await trx
        .insertInto('accounts_balance')
        .values({ org_id: orgId, billing_mode: billingMode, credit_limit_micros: creditLimit, currency: input.currency ?? 'USD' })
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx.insertInto('notification_settings').values({ org_id: orgId, email_to: [input.email] }).execute();
      const org = await trx.selectFrom('organizations').selectAll().where('id', '=', orgId).executeTakeFirstOrThrow();

      await this.audit.record({
        action: `${childRole === 'RESELLER' ? 'reseller' : 'client'}.create`,
        entityType: 'organization',
        entityId: orgId,
        targetOrgId: orgId,
        after: { org: publicOrg(org), owner: { id: user.id, email: user.email }, billing: balance },
      });
      await this.invalidation.invalidate('organizations', orgId);
      await this.invalidation.invalidate('accounts_balance', orgId);
      return { ...publicOrg(org), owner: publicUser(user), balance: balanceDto(balance) };
    });
  }

  async get(id: string) {
    const target = await this.scope.getOrg(id, 'read');
    return this.db.tenant(async (trx) => {
      const org = await trx.selectFrom('organizations').selectAll().where('id', '=', target.id).executeTakeFirstOrThrow();
      const balance = await trx.selectFrom('accounts_balance').selectAll().where('org_id', '=', target.id).executeTakeFirst();
      const counts = await this.counts(trx, org);
      // Privileged on purpose: under RLS a client can't see its reseller's row, so the view would
      // report inherited flags as permissive. Access to `id` was authorized above.
      const effective = await this.db.privileged
        .selectFrom('app.org_effective_state')
        .select(['is_active', 'can_send', 'can_api', 'can_smpp', 'effective_max_tps'])
        .where('id', '=', target.id)
        .executeTakeFirst();
      return { ...publicOrg(org), effective_state: effective ?? null, balance: balance ? balanceDto(balance) : null, counts };
    });
  }

  private async counts(trx: Transaction<DB>, org: Organization) {
    const one = async (q: Promise<{ n: number } | undefined>) => Number((await q)?.n ?? 0);
    const [users, apiKeys, smpp, webhooks, senderIds, clients] = await Promise.all([
      one(trx.selectFrom('users').select((eb) => eb.fn.countAll<number>().as('n')).where('org_id', '=', org.id).executeTakeFirst()),
      one(
        trx
          .selectFrom('api_keys')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('org_id', '=', org.id)
          .where('revoked_at', 'is', null)
          .executeTakeFirst(),
      ),
      one(trx.selectFrom('smpp_accounts').select((eb) => eb.fn.countAll<number>().as('n')).where('org_id', '=', org.id).executeTakeFirst()),
      one(trx.selectFrom('webhooks').select((eb) => eb.fn.countAll<number>().as('n')).where('org_id', '=', org.id).executeTakeFirst()),
      one(trx.selectFrom('sender_ids').select((eb) => eb.fn.countAll<number>().as('n')).where('org_id', '=', org.id).executeTakeFirst()),
      one(trx.selectFrom('organizations').select((eb) => eb.fn.countAll<number>().as('n')).where('parent_id', '=', org.id).executeTakeFirst()),
    ]);
    return {
      users,
      api_keys: apiKeys,
      smpp_accounts: smpp,
      webhooks,
      sender_ids: senderIds,
      ...(org.role === 'SUPER_ADMIN' ? { resellers: clients } : org.role === 'RESELLER' ? { clients } : {}),
    };
  }

  async patch(id: string, input: PatchOrgInput) {
    const auth = currentAuth();
    const target = await this.scope.findVisibleOrg(id);
    if (!target) throw AppError.notFound('Organization');
    const self = target.id === auth.orgId;
    if (!self && !isParentOf(auth, target)) throw AppError.forbidden('Only the parent organization may edit this organization');
    const keys = Object.keys(input) as (keyof PatchOrgInput)[];
    if (keys.length === 0) throw AppError.invalid('Nothing to update');
    if (self && !isParentOf(auth, target)) {
      const denied = keys.filter((k) => !SELF_EDITABLE.includes(k));
      if (denied.length) throw AppError.forbidden(`These fields are controlled by your parent organization: ${denied.join(', ')}`);
    }
    if (input.whitelabel_domain && target.role !== 'RESELLER') throw AppError.invalid('whitelabel_domain is only available to resellers');
    if (input.timezone !== undefined && !isValidTimezone(input.timezone)) throw AppError.invalid('Unknown timezone', { field: 'timezone' });

    return this.db.tenant(async (trx) => {
      const before = await trx.selectFrom('organizations').selectAll().where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
      const set: OrganizationUpdate = {};
      for (const k of keys) (set as Record<string, unknown>)[k] = input[k];
      const after = await trx.updateTable('organizations').set(set).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.record({ action: 'org.update', entityType: 'organization', entityId: id, targetOrgId: id, before: publicOrg(before), after: publicOrg(after) });
      await this.invalidation.invalidate('organizations', id);
      return publicOrg(after);
    });
  }

  async suspend(id: string, reason: string) {
    const target = await this.scope.requireChild(id);
    return this.updateState(target, { status: 'SUSPENDED', suspended_reason: reason }, `${roleWord(target)}.suspend`, true);
  }

  async activate(id: string) {
    const target = await this.scope.requireChild(id);
    return this.updateState(target, { status: 'ACTIVE', suspended_reason: null }, `${roleWord(target)}.activate`, false);
  }

  async channels(id: string, input: ChannelsInput) {
    const auth = currentAuth();
    // SUPER_ADMIN may toggle channels on ANY org (including a client of a reseller) — e.g. stop
    // SMPP for one client in one click; a reseller only on its own direct clients.
    const target = auth.role === 'SUPER_ADMIN' ? await this.scope.getOrg(id, 'read') : await this.scope.requireChild(id);
    if (Object.keys(input).length === 0) throw AppError.invalid('Nothing to update');
    return this.db.tenant(async (trx) => {
      const before = await trx.selectFrom('organizations').selectAll().where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
      // SMPP sessions need SMPP *and* sending rights (CONTRACTS §4: SENDING_DISABLED refuses binds).
      const kick = (input.smpp_enabled === false && before.smpp_enabled) || (input.sending_enabled === false && before.sending_enabled);
      return this.updateState(target, input, `${roleWord(target)}.channels`, kick);
    });
  }

  /**
   * SUPER_ADMIN-only: turn per-client content pre-approval on/off for any org. When on, the client
   * may only send content a SUPER_ADMIN has approved (engine policy.CheckApprovedContent). No kick:
   * it gates submits, not binds.
   */
  async contentApproval(id: string, required: boolean) {
    const target = await this.scope.getOrg(id, 'read');
    return this.updateState(target, { content_approval_required: required }, 'org.content_approval', false);
  }

  /**
   * Deletes a child org. Default is a reversible *close* (status CLOSED, all channels off, every
   * session revoked) — the org disappears from day-to-day use but its history and billing stay and
   * `activate` brings it back. `purge: true` is a permanent hard delete: it needs the org to be
   * closed/suspended first and to have no sub-orgs, then cascades away users, balances, SMPP
   * accounts, API keys, webhooks, etc. (message history and audit logs are kept on purpose).
   */
  async remove(id: string, opts: { purge?: boolean; reason?: string } = {}) {
    const target = await this.scope.requireChild(id);
    if (!opts.purge) {
      return this.db.tenant(async (trx) => {
        const before = await trx.selectFrom('organizations').selectAll().where('id', '=', target.id).forUpdate().executeTakeFirstOrThrow();
        const after = await trx
          .updateTable('organizations')
          .set({
            status: 'CLOSED',
            suspended_reason: opts.reason ?? 'Closed by parent organization',
            sending_enabled: false,
            api_enabled: false,
            smpp_enabled: false,
            web_enabled: false,
          })
          .where('id', '=', target.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        // Log everyone out: this org's own users, plus anyone impersonating into it.
        await trx
          .updateTable('refresh_tokens')
          .set({ revoked_at: new Date(), revoked_reason: 'org_closed' })
          .where('revoked_at', 'is', null)
          .where((eb) =>
            eb.or([
              eb('user_id', 'in', eb.selectFrom('users').select('id').where('org_id', '=', target.id)),
              eb('impersonated_org_id', '=', target.id),
            ]),
          )
          .execute();
        await this.audit.record({
          action: `${roleWord(target)}.close`,
          entityType: 'organization',
          entityId: target.id,
          targetOrgId: target.id,
          before: publicOrg(before),
          after: publicOrg(after),
        });
        await this.invalidation.invalidate('organizations', target.id);
        const childIds =
          target.role === 'RESELLER'
            ? (await trx.selectFrom('organizations').select('id').where('parent_id', '=', target.id).execute()).map((r) => r.id)
            : [];
        await this.db.afterCommit(async () => {
          await this.engine.reloadConfigQuietly();
          for (const orgId of [target.id, ...childIds]) await this.engine.kickQuietly(orgId);
        });
        return publicOrg(after);
      });
    }
    // Permanent delete: guard against the two ways it silently loses data or fails.
    if (target.status === 'ACTIVE') {
      throw AppError.invalid(`Close this ${roleWord(target)} before permanently deleting it`);
    }
    const children = await this.db.tenant((trx) =>
      trx.selectFrom('organizations').select((eb) => eb.fn.countAll<number>().as('n')).where('parent_id', '=', target.id).executeTakeFirst(),
    );
    if (Number(children?.n ?? 0) > 0) {
      throw AppError.invalid(`Cannot permanently delete a ${roleWord(target)} that still has sub-organizations; delete those first`);
    }
    return this.db.tenant(async (trx) => {
      const before = await trx.selectFrom('organizations').selectAll().where('id', '=', target.id).forUpdate().executeTakeFirstOrThrow();
      // users / accounts_balance / balance_transactions / smpp_accounts / api_keys / webhooks /
      // sender_ids / ip_whitelists / route assignments cascade via ON DELETE CASCADE; message_logs
      // and audit_logs have no FK and are retained for history/compliance.
      await trx.deleteFrom('organizations').where('id', '=', target.id).execute();
      await this.audit.record({
        action: `${roleWord(target)}.delete`,
        entityType: 'organization',
        entityId: target.id,
        targetOrgId: target.id,
        before: publicOrg(before),
      });
      await this.invalidation.invalidate('organizations', target.id);
      await this.db.afterCommit(async () => {
        await this.engine.reloadConfigQuietly();
        await this.engine.kickQuietly(target.id);
      });
      return { id: target.id, deleted: true };
    });
  }

  /** Shared by suspend/activate/channels: update, audit, invalidate, kick SMPP after commit. */
  private async updateState(target: ScopedOrg, set: OrganizationUpdate, action: string, kick: boolean) {
    return this.db.tenant(async (trx) => {
      const before = await trx.selectFrom('organizations').selectAll().where('id', '=', target.id).forUpdate().executeTakeFirstOrThrow();
      const after = await trx.updateTable('organizations').set(set).where('id', '=', target.id).returningAll().executeTakeFirstOrThrow();
      await this.audit.record({ action, entityType: 'organization', entityId: target.id, targetOrgId: target.id, before: publicOrg(before), after: publicOrg(after) });
      await this.invalidation.invalidate('organizations', target.id);
      if (set.status === 'SUSPENDED') {
        // Its users' impersonation sessions (into its children) end with it; the auth guard and
        // refresh also refuse them because the real org is no longer active.
        await trx
          .updateTable('refresh_tokens')
          .set({ revoked_at: new Date(), revoked_reason: 'org_suspended' })
          .where('impersonated_org_id', 'is not', null)
          .where('revoked_at', 'is', null)
          .where('user_id', 'in', (eb) => eb.selectFrom('users').select('id').where('org_id', '=', target.id))
          .execute();
      }
      // A reseller's state also gates its clients (app.org_effective_state), so kick them too.
      const childIds =
        kick && target.role === 'RESELLER'
          ? (await trx.selectFrom('organizations').select('id').where('parent_id', '=', target.id).execute()).map((r) => r.id)
          : [];
      await this.db.afterCommit(async () => {
        // Apply the new state in the engine now (pubsub reload is debounced): a suspended or
        // disabled org must not re-bind / submit in that window, a re-enabled one may send at once.
        await this.engine.reloadConfigQuietly();
        if (kick) for (const orgId of [target.id, ...childIds]) await this.engine.kickQuietly(orgId);
      });
      return publicOrg(after);
    });
  }

  // ---------------------------------------------------------------------------
  // Users
  // ---------------------------------------------------------------------------

  async listUsers(orgId: string, p: Pagination) {
    await this.scope.getOrg(orgId, 'read');
    return this.db.tenant(async (trx) => {
      const [{ total }] = await trx.selectFrom('users').select((eb) => eb.fn.countAll<number>().as('total')).where('org_id', '=', orgId).execute();
      const rows = await trx.selectFrom('users').selectAll().where('org_id', '=', orgId).orderBy('created_at').limit(p.page_size).offset(offsetOf(p)).execute();
      return page(rows.map(publicUser), total, p);
    });
  }

  async createUser(orgId: string, input: { email: string; password: string; full_name?: string }) {
    await this.scope.getOrg(orgId, 'write');
    const hash = await this.crypto.hashPassword(input.password);
    return this.db.tenant(async (trx) => {
      const user = await trx
        .insertInto('users')
        .values({ org_id: orgId, email: input.email, password_hash: hash, full_name: input.full_name ?? null })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record({ action: 'user.create', entityType: 'user', entityId: user.id, targetOrgId: orgId, after: publicUser(user) });
      return publicUser(user);
    });
  }

  /**
   * Parent only (directly or while impersonating the org): resetting needs no current password
   * or 2FA, so an org's own session must not use it (self-service is POST /api/auth/password).
   */
  async resetUserPassword(orgId: string, userId: string, newPassword: string) {
    await this.scope.requireParentActor(orgId, 'Only the parent organization may reset passwords; use /api/auth/password for your own');
    const hash = await this.crypto.hashPassword(newPassword);
    return this.db.tenant(async (trx) => {
      const user = await trx
        .updateTable('users')
        .set({ password_hash: hash, password_changed_at: new Date(), failed_login_count: 0, locked_until: null })
        .where('id', '=', userId)
        .where('org_id', '=', orgId)
        .returningAll()
        .executeTakeFirst();
      if (!user) throw AppError.notFound('User');
      await this.revokeSessions(trx, userId, 'password_reset');
      await this.audit.record({ action: 'user.reset_password', entityType: 'user', entityId: userId, targetOrgId: orgId });
      return publicUser(user);
    });
  }

  /** full_name: the org itself or its parent; is_active: the parent only (a deactivation by the parent sticks). */
  async patchUser(orgId: string, userId: string, input: { is_active?: boolean; full_name?: string | null }) {
    const auth = currentAuth();
    if (input.is_active !== undefined) await this.scope.requireParentActor(orgId, 'Only the parent organization may activate or deactivate users');
    else await this.scope.getOrg(orgId, 'write');
    if (input.is_active === false && userId === auth.userId) throw AppError.invalid('You cannot deactivate yourself');
    return this.db.tenant(async (trx) => {
      const before = await trx.selectFrom('users').selectAll().where('id', '=', userId).where('org_id', '=', orgId).executeTakeFirst();
      if (!before) throw AppError.notFound('User');
      const after = await trx.updateTable('users').set(input).where('id', '=', userId).returningAll().executeTakeFirstOrThrow();
      if (input.is_active === false) await this.revokeSessions(trx, userId, 'user_disabled');
      await this.audit.record({ action: 'user.update', entityType: 'user', entityId: userId, targetOrgId: orgId, before: publicUser(before), after: publicUser(after) });
      return publicUser(after);
    });
  }

  /**
   * Parent only: permanently deletes a user. You cannot delete yourself, and the last remaining
   * user of an org cannot be removed (that would leave it with no login — close the org instead).
   * The user's refresh tokens cascade away via FK.
   */
  async deleteUser(orgId: string, userId: string) {
    const auth = currentAuth();
    await this.scope.requireParentActor(orgId, 'Only the parent organization may delete users');
    if (userId === auth.userId) throw AppError.invalid('You cannot delete yourself');
    return this.db.tenant(async (trx) => {
      const before = await trx.selectFrom('users').selectAll().where('id', '=', userId).where('org_id', '=', orgId).executeTakeFirst();
      if (!before) throw AppError.notFound('User');
      const [{ n }] = await trx.selectFrom('users').select((eb) => eb.fn.countAll<number>().as('n')).where('org_id', '=', orgId).execute();
      if (Number(n) <= 1) throw AppError.invalid('Cannot delete the only user of an organization; close the organization instead');
      await trx.deleteFrom('users').where('id', '=', userId).where('org_id', '=', orgId).execute();
      await this.audit.record({ action: 'user.delete', entityType: 'user', entityId: userId, targetOrgId: orgId, before: publicUser(before) });
      return { id: userId, deleted: true };
    });
  }

  private async revokeSessions(trx: Transaction<DB>, userId: string, reason: string): Promise<void> {
    await trx
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date(), revoked_reason: reason })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  /** Exposed for other modules (e.g. balance) that need the same visibility rules. */
  canAccess(target: ScopedOrg, mode: 'read' | 'write'): boolean {
    return canAccessOrg(currentAuth(), target, mode);
  }
}

function roleWord(o: ScopedOrg): string {
  return o.role === 'RESELLER' ? 'reseller' : 'client';
}

export function balanceDto(b: {
  org_id: string;
  balance_micros: number;
  credit_limit_micros: number;
  billing_mode: BillingMode;
  currency: string;
  low_balance_alert_micros: number | null;
  updated_at?: Date;
}) {
  return {
    org_id: b.org_id,
    balance_micros: b.balance_micros,
    credit_limit_micros: b.credit_limit_micros,
    billing_mode: b.billing_mode,
    currency: b.currency.trim(),
    low_balance_alert_micros: b.low_balance_alert_micros,
  };
}
