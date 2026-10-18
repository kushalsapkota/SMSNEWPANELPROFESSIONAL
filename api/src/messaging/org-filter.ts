import { RawBuilder, sql } from 'kysely';
import { currentAuth } from '../common/context';
import type { ScopeService } from '../tenancy/scope.service';

/** Which tenants a report covers (CONTRACTS §10 "reseller without org_id = all its clients; admin = everything"). */
export type OrgFilter = { kind: 'all' } | { kind: 'org'; id: string } | { kind: 'tree'; id: string };

/**
 * `?org_id=` → covered orgs. A RESELLER org means its whole tree (own sends + its clients');
 * a CLIENT just itself; the admin itself (or no param, for the admin) = everything.
 * Out-of-scope ids are 403 (ScopeService.resolve).
 */
export async function resolveOrgFilter(scope: ScopeService, orgIdParam?: string): Promise<OrgFilter> {
  if (orgIdParam) {
    const org = await scope.resolve(orgIdParam, 'read');
    if (org.role === 'SUPER_ADMIN') return { kind: 'all' };
    return org.role === 'RESELLER' ? { kind: 'tree', id: org.id } : { kind: 'org', id: org.id };
  }
  return actingOrgFilter();
}

export function actingOrgFilter(): OrgFilter {
  const auth = currentAuth();
  if (auth.role === 'SUPER_ADMIN') return { kind: 'all' };
  return auth.role === 'RESELLER' ? { kind: 'tree', id: auth.orgId } : { kind: 'org', id: auth.orgId };
}

/** SQL conditions on a table alias with org_id / reseller_id columns (message_logs, message_stats_hourly). */
export function orgFilterConds(f: OrgFilter, alias: 'm' | 's'): RawBuilder<boolean>[] {
  const org = sql.ref(`${alias}.org_id`);
  const reseller = sql.ref(`${alias}.reseller_id`);
  if (f.kind === 'org') return [sql<boolean>`${org} = ${f.id}::uuid`];
  if (f.kind === 'tree') return [sql<boolean>`(${org} = ${f.id}::uuid or ${reseller} = ${f.id}::uuid)`];
  return [];
}

/** AND of conditions as one boolean expression (usable in Kysely .where()). */
export function allOf(conds: RawBuilder<boolean>[]): RawBuilder<boolean> {
  return conds.length === 0 ? sql<boolean>`true` : sql<boolean>`${sql.join(conds, sql` and `)}`;
}
