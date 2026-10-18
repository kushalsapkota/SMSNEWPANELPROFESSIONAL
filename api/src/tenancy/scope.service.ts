import { Global, Injectable, Module } from '@nestjs/common';
import { AuthContext, currentAuth } from '../common/context';
import { AppError } from '../common/errors';
import { DbService } from '../db/db.service';
import type { OrgRole, OrgStatus } from '../db/types';

export type AccessMode = 'read' | 'write';

export interface ScopedOrg {
  id: string;
  role: OrgRole;
  parent_id: string | null;
  name: string;
  status: OrgStatus;
}

/**
 * CONTRACTS §10 authorization rules, enforced in code (RLS enforces isolation underneath):
 *   - any org may act on itself;
 *   - SUPER_ADMIN may act on RESELLERs, and read (only) their CLIENTs;
 *   - RESELLER may act on its own CLIENTs;
 *   - CLIENT only on itself.
 */
export function canAccessOrg(auth: AuthContext, target: ScopedOrg, mode: AccessMode): boolean {
  if (target.id === auth.orgId) return true;
  if (auth.role === 'SUPER_ADMIN') {
    if (target.role === 'RESELLER') return true;
    if (target.role === 'CLIENT') return mode === 'read';
    return false;
  }
  if (auth.role === 'RESELLER') return target.role === 'CLIENT' && target.parent_id === auth.orgId;
  return false;
}

/** Management actions on a child org (suspend, routes, balance...): only the direct parent. */
export function isParentOf(auth: AuthContext, target: ScopedOrg): boolean {
  return target.parent_id === auth.orgId && (
    (auth.role === 'SUPER_ADMIN' && target.role === 'RESELLER') || (auth.role === 'RESELLER' && target.role === 'CLIENT')
  );
}

@Injectable()
export class ScopeService {
  constructor(private readonly db: DbService) {}

  /** Loads an org through the tenant transaction (RLS-filtered). */
  async findVisibleOrg(id: string): Promise<ScopedOrg | undefined> {
    if (!isUuid(id)) return undefined;
    return this.db.tenant((trx) =>
      trx
        .selectFrom('organizations')
        .select(['id', 'role', 'parent_id', 'name', 'status'])
        .where('id', '=', id)
        .executeTakeFirst(),
    );
  }

  /**
   * Resolves `?org_id=` for scoped endpoints (default: acting org). Anything outside the
   * caller's scope — including orgs that don't exist or are hidden by RLS — is 403.
   */
  async resolve(orgIdParam: string | undefined | null, mode: AccessMode): Promise<ScopedOrg> {
    const auth = currentAuth();
    const id = orgIdParam && orgIdParam.length > 0 ? orgIdParam : auth.orgId;
    if (!isUuid(id)) throw AppError.invalid('org_id must be a UUID');
    const org = await this.findVisibleOrg(id);
    if (!org || !canAccessOrg(auth, org, mode)) {
      throw AppError.forbidden(mode === 'write' ? 'You may not modify this organization' : 'You may not access this organization');
    }
    return org;
  }

  /** For a row already loaded through RLS: 403 if the caller may not act on its org. */
  async assertOrgAccess(orgId: string, mode: AccessMode): Promise<ScopedOrg> {
    const auth = currentAuth();
    const org = await this.findVisibleOrg(orgId);
    if (!org) throw AppError.notFound('Organization');
    if (!canAccessOrg(auth, org, mode)) {
      throw AppError.forbidden(mode === 'write' ? 'You may not modify this organization' : 'You may not access this organization');
    }
    return org;
  }

  /** `/api/orgs/:id` lookup: 404 when invisible, 403 when visible but not readable/writable. */
  async getOrg(id: string, mode: AccessMode): Promise<ScopedOrg> {
    const org = await this.findVisibleOrg(id);
    if (!org) throw AppError.notFound('Organization');
    if (!canAccessOrg(currentAuth(), org, mode)) throw AppError.forbidden();
    return org;
  }

  /** Requires the caller to be the direct parent of org `id` (admin->reseller, reseller->client). */
  async requireChild(id: string): Promise<ScopedOrg> {
    const auth = currentAuth();
    const org = await this.findVisibleOrg(id);
    if (!org) throw AppError.notFound('Organization');
    if (!isParentOf(auth, org)) throw AppError.forbidden('Only the parent organization may perform this action');
    return org;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

@Global()
@Module({ providers: [ScopeService], exports: [ScopeService] })
export class TenancyModule {}
