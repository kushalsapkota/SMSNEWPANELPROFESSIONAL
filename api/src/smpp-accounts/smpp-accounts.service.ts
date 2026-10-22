import { Injectable } from '@nestjs/common';
import { Transaction, sql } from 'kysely';
import { AuditService } from '../audit/audit.service';
import { currentAuth } from '../common/context';
import { AppError } from '../common/errors';
import { Pagination, offsetOf, page } from '../common/pagination';
import { CryptoService } from '../crypto/crypto.service';
import { DbService } from '../db/db.service';
import type { BindType, DB } from '../db/types';
import { EngineClient } from '../engine/engine-client.service';
import { InvalidationService } from '../redis/redis.module';
import { ScopeService, ScopedOrg, isParentActor } from '../tenancy/scope.service';

export interface SmppAccountInput {
  system_id: string;
  password: string;
  max_binds?: number;
  max_tps?: number | null;
  allowed_bind_types?: BindType[];
  enabled?: boolean;
}

/** password_hash never leaves the api. bind_type[] is cast to text[] (pg can't parse enum arrays). */
function columns(trx: Transaction<DB>) {
  return trx
    .selectFrom('smpp_accounts')
    .select([
      'id',
      'org_id',
      'system_id',
      'max_binds',
      'max_tps',
      'enabled',
      'locked_by_parent',
      'last_bind_at',
      'last_bind_ip',
      'created_at',
      'updated_at',
      sql<BindType[]>`allowed_bind_types::text[]`.as('allowed_bind_types'),
    ]);
}

@Injectable()
export class SmppAccountsService {
  constructor(
    private readonly db: DbService,
    private readonly scope: ScopeService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly invalidation: InvalidationService,
    private readonly engine: EngineClient,
  ) {}

  async list(q: Pagination & { org_id?: string }) {
    const org = await this.scope.resolve(q.org_id, 'read');
    return this.db.tenant(async (trx) => {
      const [{ total }] = await trx.selectFrom('smpp_accounts').select((eb) => eb.fn.countAll<number>().as('total')).where('org_id', '=', org.id).execute();
      const rows = await columns(trx).where('org_id', '=', org.id).orderBy('system_id').limit(q.page_size).offset(offsetOf(q)).execute();
      return page(rows, total, q);
    });
  }

  async create(orgIdParam: string | undefined, input: SmppAccountInput) {
    const org = await this.scope.resolve(orgIdParam, 'write');
    if (org.role === 'SUPER_ADMIN') throw AppError.invalid('SMPP accounts belong to resellers and clients');
    const hash = await this.crypto.hashPassword(input.password);
    const passwordEnc = this.crypto.encrypt(input.password);
    return this.db.tenant(async (trx) => {
      const { id } = await trx
        .insertInto('smpp_accounts')
        .values({
          org_id: org.id,
          system_id: input.system_id,
          password_hash: hash,
          password_enc: passwordEnc,
          max_binds: input.max_binds,
          max_tps: input.max_tps ?? null,
          allowed_bind_types: input.allowed_bind_types,
          enabled: input.enabled,
          locked_by_parent: isParentActor(currentAuth(), org),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const row = await columns(trx).where('id', '=', id).executeTakeFirstOrThrow();
      await this.audit.record({ action: 'smpp_account.create', entityType: 'smpp_account', entityId: id, targetOrgId: org.id, after: row });
      await this.invalidation.invalidate('smpp_accounts', id);
      return row;
    });
  }

  /**
   * The parent's settings stick: an update by the parent (also while impersonating) locks the
   * account, and the org itself may then only tighten it (disable, fewer binds, lower TPS,
   * fewer bind types) — never re-enable or loosen what the parent set.
   */
  async update(id: string, input: Partial<Omit<SmppAccountInput, 'system_id' | 'password'>>) {
    if (Object.keys(input).length === 0) throw AppError.invalid('Nothing to update');
    return this.db.tenant(async (trx) => {
      const { row: before, org } = await this.loadWithOrg(trx, id);
      const byParent = isParentActor(currentAuth(), org);
      if (!byParent && before.locked_by_parent) {
        const loosened = loosenedFields(before, input);
        if (loosened.length > 0) {
          throw new AppError('FORBIDDEN', 'Your parent organization manages this SMPP account; you may only restrict it further', { fields: loosened });
        }
      }
      await trx
        .updateTable('smpp_accounts')
        .set({ ...input, ...(byParent ? { locked_by_parent: true } : {}) })
        .where('id', '=', id)
        .execute();
      const after = await columns(trx).where('id', '=', id).executeTakeFirstOrThrow();
      await this.audit.record({ action: 'smpp_account.update', entityType: 'smpp_account', entityId: id, targetOrgId: before.org_id, before, after });
      await this.invalidation.invalidate('smpp_accounts', id);
      if (before.enabled && input.enabled === false) await this.kickAfterCommit(before.org_id);
      return after;
    });
  }

  /** A parent-managed account can't be deleted (and re-created unlocked) by the org itself. */
  async remove(id: string) {
    return this.db.tenant(async (trx) => {
      const { row: before, org } = await this.loadWithOrg(trx, id);
      if (before.locked_by_parent && !isParentActor(currentAuth(), org)) {
        throw AppError.forbidden('Your parent organization manages this SMPP account; ask it to delete the account');
      }
      await trx.deleteFrom('smpp_accounts').where('id', '=', id).execute();
      await this.audit.record({ action: 'smpp_account.delete', entityType: 'smpp_account', entityId: id, targetOrgId: before.org_id, before });
      await this.invalidation.invalidate('smpp_accounts', id);
      await this.kickAfterCommit(before.org_id);
      return { ok: true };
    });
  }

  /** Rotate the bind password; live sessions are kicked so they must rebind with it. */
  async rotatePassword(id: string, password: string) {
    const hash = await this.crypto.hashPassword(password);
    const passwordEnc = this.crypto.encrypt(password);
    return this.db.tenant(async (trx) => {
      const before = await this.load(trx, id);
      await trx.updateTable('smpp_accounts').set({ password_hash: hash, password_enc: passwordEnc }).where('id', '=', id).execute();
      const after = await columns(trx).where('id', '=', id).executeTakeFirstOrThrow();
      await this.audit.record({ action: 'smpp_account.password_rotate', entityType: 'smpp_account', entityId: id, targetOrgId: before.org_id });
      await this.invalidation.invalidate('smpp_accounts', id);
      await this.kickAfterCommit(before.org_id);
      return after;
    });
  }

  /**
   * Reveal the bind password (and system_id) so the parent, admin, or the org itself can copy the
   * full SMPP connection. Readable by anyone who can read the org (admin → its tree, reseller → its
   * clients, a client → itself). Every reveal is audited. `password` is null for pre-008 accounts
   * whose password predates reversible storage — rotate it once to make it copyable.
   */
  async credentials(id: string) {
    return this.db.tenant(async (trx) => {
      const row = await trx
        .selectFrom('smpp_accounts')
        .select(['id', 'org_id', 'system_id', 'password_enc', 'enabled'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!row) throw AppError.notFound('SMPP account');
      await this.scope.assertOrgAccess(row.org_id, 'read');
      let password: string | null = null;
      if (row.password_enc) {
        try {
          password = this.crypto.decrypt(row.password_enc);
        } catch {
          password = null; // undecryptable (e.g. key rotation): treat as not revealable
        }
      }
      await this.audit.record({
        action: 'smpp_account.credentials_view',
        entityType: 'smpp_account',
        entityId: id,
        targetOrgId: row.org_id,
      });
      return { id: row.id, system_id: row.system_id, password, password_available: password !== null, enabled: row.enabled };
    });
  }

  private async load(trx: Transaction<DB>, id: string) {
    return (await this.loadWithOrg(trx, id)).row;
  }

  private async loadWithOrg(trx: Transaction<DB>, id: string) {
    const row = await columns(trx).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!row) throw AppError.notFound('SMPP account');
    const org: ScopedOrg = await this.scope.assertOrgAccess(row.org_id, 'write');
    return { row, org };
  }

  private kickAfterCommit(orgId: string): Promise<void> {
    return this.db.afterCommit(() => this.engine.kickQuietly(orgId));
  }
}

/** Fields of `input` that would loosen the account compared to `before` (re-enable, raise limits, add bind types). */
export function loosenedFields(
  before: { enabled: boolean; max_binds: number; max_tps: number | null; allowed_bind_types: BindType[] },
  input: Partial<Pick<SmppAccountInput, 'enabled' | 'max_binds' | 'max_tps' | 'allowed_bind_types'>>,
): string[] {
  const out: string[] = [];
  if (input.enabled === true && !before.enabled) out.push('enabled');
  if (input.max_binds !== undefined && input.max_binds > before.max_binds) out.push('max_binds');
  if (input.max_tps !== undefined) {
    // null = no account cap (only the org's): looser than any number.
    const loosens = before.max_tps !== null && (input.max_tps === null || input.max_tps > before.max_tps);
    if (loosens) out.push('max_tps');
  }
  if (input.allowed_bind_types !== undefined && input.allowed_bind_types.some((t) => !before.allowed_bind_types.includes(t))) {
    out.push('allowed_bind_types');
  }
  return out;
}
