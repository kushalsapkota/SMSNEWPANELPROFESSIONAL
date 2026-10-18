import { Injectable } from '@nestjs/common';
import { Transaction, sql } from 'kysely';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/errors';
import { Pagination, offsetOf, page } from '../common/pagination';
import { CryptoService } from '../crypto/crypto.service';
import { DbService } from '../db/db.service';
import type { BindType, DB } from '../db/types';
import { EngineClient } from '../engine/engine-client.service';
import { InvalidationService } from '../redis/redis.module';
import { ScopeService } from '../tenancy/scope.service';

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
    return this.db.tenant(async (trx) => {
      const { id } = await trx
        .insertInto('smpp_accounts')
        .values({
          org_id: org.id,
          system_id: input.system_id,
          password_hash: hash,
          max_binds: input.max_binds,
          max_tps: input.max_tps ?? null,
          allowed_bind_types: input.allowed_bind_types,
          enabled: input.enabled,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const row = await columns(trx).where('id', '=', id).executeTakeFirstOrThrow();
      await this.audit.record({ action: 'smpp_account.create', entityType: 'smpp_account', entityId: id, targetOrgId: org.id, after: row });
      await this.invalidation.invalidate('smpp_accounts', id);
      return row;
    });
  }

  async update(id: string, input: Partial<Omit<SmppAccountInput, 'system_id' | 'password'>>) {
    if (Object.keys(input).length === 0) throw AppError.invalid('Nothing to update');
    return this.db.tenant(async (trx) => {
      const before = await this.load(trx, id);
      await trx.updateTable('smpp_accounts').set(input).where('id', '=', id).execute();
      const after = await columns(trx).where('id', '=', id).executeTakeFirstOrThrow();
      await this.audit.record({ action: 'smpp_account.update', entityType: 'smpp_account', entityId: id, targetOrgId: before.org_id, before, after });
      await this.invalidation.invalidate('smpp_accounts', id);
      if (before.enabled && input.enabled === false) await this.kickAfterCommit(before.org_id);
      return after;
    });
  }

  async remove(id: string) {
    return this.db.tenant(async (trx) => {
      const before = await this.load(trx, id);
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
    return this.db.tenant(async (trx) => {
      const before = await this.load(trx, id);
      await trx.updateTable('smpp_accounts').set({ password_hash: hash }).where('id', '=', id).execute();
      const after = await columns(trx).where('id', '=', id).executeTakeFirstOrThrow();
      await this.audit.record({ action: 'smpp_account.password_rotate', entityType: 'smpp_account', entityId: id, targetOrgId: before.org_id });
      await this.invalidation.invalidate('smpp_accounts', id);
      await this.kickAfterCommit(before.org_id);
      return after;
    });
  }

  private async load(trx: Transaction<DB>, id: string) {
    const row = await columns(trx).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!row) throw AppError.notFound('SMPP account');
    await this.scope.assertOrgAccess(row.org_id, 'write');
    return row;
  }

  private kickAfterCommit(orgId: string): Promise<void> {
    return this.db.afterCommit(() => this.engine.kickQuietly(orgId));
  }
}
