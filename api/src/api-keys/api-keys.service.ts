import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { currentAuth } from '../common/context';
import { AppError } from '../common/errors';
import { Pagination, offsetOf, page } from '../common/pagination';
import { CryptoService } from '../crypto/crypto.service';
import { DbService } from '../db/db.service';
import type { ApiKey } from '../db/types';
import { ScopeService } from '../tenancy/scope.service';

/** key_hash is never returned; the full key only once, from create(). */
export function apiKeyDto(k: ApiKey) {
  return {
    id: k.id,
    org_id: k.org_id,
    name: k.name,
    key_prefix: k.key_prefix,
    scopes: k.scopes,
    last_used_at: k.last_used_at,
    expires_at: k.expires_at,
    revoked_at: k.revoked_at,
    created_by_user_id: k.created_by_user_id,
    created_at: k.created_at,
  };
}

@Injectable()
export class ApiKeysService {
  constructor(
    private readonly db: DbService,
    private readonly scope: ScopeService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  async list(q: Pagination & { org_id?: string; include_revoked?: boolean }) {
    const org = await this.scope.resolve(q.org_id, 'read');
    return this.db.tenant(async (trx) => {
      let base = trx.selectFrom('api_keys').where('org_id', '=', org.id);
      if (!q.include_revoked) base = base.where('revoked_at', 'is', null);
      const [{ total }] = await base.select((eb) => eb.fn.countAll<number>().as('total')).execute();
      const rows = await base.selectAll().orderBy('created_at', 'desc').limit(q.page_size).offset(offsetOf(q)).execute();
      return page(rows.map(apiKeyDto), total, q);
    });
  }

  async create(orgIdParam: string | undefined, input: { name: string; scopes?: string[]; expires_at?: string | null }) {
    const auth = currentAuth();
    const org = await this.scope.resolve(orgIdParam, 'write');
    if (org.role === 'SUPER_ADMIN') throw AppError.invalid('API keys belong to resellers and clients');
    if (input.expires_at && new Date(input.expires_at).getTime() <= Date.now()) throw AppError.invalid('expires_at must be in the future');
    return this.db.tenant(async (trx) => {
      // key_prefix (12 chars) is UNIQUE; on the rare collision retry inside a savepoint.
      for (let attempt = 0; attempt < 5; attempt++) {
        const gen = this.crypto.generateApiKey();
        try {
          const row = await this.db.savepoint(trx, 'api_key_insert', () =>
            trx
              .insertInto('api_keys')
              .values({
                org_id: org.id,
                name: input.name,
                key_prefix: gen.prefix,
                key_hash: gen.hash,
                scopes: input.scopes,
                expires_at: input.expires_at ?? null,
                created_by_user_id: auth.userId,
              })
              .returningAll()
              .executeTakeFirstOrThrow(),
          );
          await this.audit.record({ action: 'api_key.create', entityType: 'api_key', entityId: row.id, targetOrgId: org.id, after: apiKeyDto(row) });
          return { ...apiKeyDto(row), key: gen.key };
        } catch (e) {
          if ((e as { code?: string; constraint?: string }).code === '23505' && attempt < 4) continue;
          throw e;
        }
      }
      throw AppError.internal('Could not generate a unique API key');
    });
  }

  async revoke(id: string) {
    return this.db.tenant(async (trx) => {
      const before = await trx.selectFrom('api_keys').selectAll().where('id', '=', id).executeTakeFirst();
      if (!before) throw AppError.notFound('API key');
      await this.scope.assertOrgAccess(before.org_id, 'write');
      if (before.revoked_at) return apiKeyDto(before);
      const after = await trx.updateTable('api_keys').set({ revoked_at: new Date() }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.record({ action: 'api_key.revoke', entityType: 'api_key', entityId: id, targetOrgId: before.org_id, before: apiKeyDto(before), after: apiKeyDto(after) });
      return apiKeyDto(after);
    });
  }
}
