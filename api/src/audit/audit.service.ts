import { Global, Injectable, Module } from '@nestjs/common';
import { currentMeta, currentStore } from '../common/context';
import { DbService } from '../db/db.service';

const SENSITIVE_KEY = /(password|secret|_enc$|key_hash|token_hash|totp|recovery)/i;

/** Deep-copies a record dropping credentials so audit before/after never stores secrets. */
export function sanitizeForAudit(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return undefined;
  if (Array.isArray(value)) return value.map(sanitizeForAudit);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(k)) continue;
      const s = sanitizeForAudit(v);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return value;
}

export interface AuditEntry {
  /** dotted verb, e.g. 'org.create', 'client.suspend', 'route.assign', 'api_key.revoke' */
  action: string;
  entityType?: string;
  entityId?: string | number | null;
  targetOrgId?: string | null;
  before?: unknown;
  after?: unknown;
}

export interface ExplicitActor {
  userId: string | null;
  orgId: string | null;
  impersonatorUserId?: string | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly db: DbService) {}

  /**
   * Writes an audit row inside the current tenant transaction (rolled back with the action).
   * actor_org_id = acting org (RLS requires it), impersonator_user_id = `imp` claim.
   */
  async record(entry: AuditEntry): Promise<void> {
    const auth = currentStore()?.auth;
    if (!auth) throw new Error('AuditService.record requires an authenticated context; use recordAs');
    await this.db.tenant((trx) =>
      trx
        .insertInto('audit_logs')
        .values(this.row(entry, { userId: auth.userId, orgId: auth.orgId, impersonatorUserId: auth.impersonatorUserId ?? null }))
        .execute(),
    );
  }

  /** Privileged write for auth flows (login, lockout, impersonation) where no tenant tx exists. */
  async recordAs(actor: ExplicitActor, entry: AuditEntry): Promise<void> {
    await this.db.privileged.insertInto('audit_logs').values(this.row(entry, actor)).execute();
  }

  private row(entry: AuditEntry, actor: ExplicitActor) {
    const meta = currentMeta();
    const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(sanitizeForAudit(v)));
    return {
      actor_user_id: actor.userId,
      actor_org_id: actor.orgId,
      impersonator_user_id: actor.impersonatorUserId ?? null,
      target_org_id: entry.targetOrgId ?? null,
      action: entry.action,
      entity_type: entry.entityType ?? null,
      entity_id: entry.entityId === undefined || entry.entityId === null ? null : String(entry.entityId),
      before: json(entry.before),
      after: json(entry.after),
      ip: meta.ip,
      user_agent: meta.userAgent,
    };
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
