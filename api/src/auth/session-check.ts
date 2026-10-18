import { Kysely, Transaction, sql } from 'kysely';
import type { DB, OrgRole } from '../db/types';

/**
 * Re-validation of a panel session (access token on every request, refresh token on refresh).
 *
 * The REAL org (the user's own org) must be active, and the client IP must pass the real org's
 * PANEL/ALL whitelist, in every case — also while impersonating (a suspended reseller keeps no
 * access to its clients; the impersonator's IP is what matters). While impersonating, the
 * acting org must still be a direct child the real org may impersonate (admin → its resellers,
 * reseller → its clients). Without impersonation the acting org IS the real org.
 */
export type SessionVerdict =
  | { ok: true; passwordChangedAt: Date; actingRole: OrgRole; realOrgId: string }
  | { ok: false; reason: 'user' | 'org' | 'suspended' | 'impersonation' | 'ip' };

/** Who may impersonate whom (decided on the real org): the direct parent only, never admin → client. */
export function mayImpersonate(realRole: OrgRole, realOrgId: string, target: { role: OrgRole; parent_id: string | null }): boolean {
  if (target.parent_id !== realOrgId) return false;
  return (realRole === 'SUPER_ADMIN' && target.role === 'RESELLER') || (realRole === 'RESELLER' && target.role === 'CLIENT');
}

export async function evaluateSession(
  db: Kysely<DB> | Transaction<DB>,
  p: { userId: string; actingOrgId: string; impersonating: boolean; ip: string | null },
): Promise<SessionVerdict> {
  const r = await sql<{
    user_active: boolean;
    password_changed_at: Date;
    real_org_id: string;
    real_role: OrgRole;
    real_active: boolean;
    acting_role: OrgRole | null;
    acting_parent: string | null;
    ip_ok: boolean;
  }>`
    select u.is_active as user_active, u.password_changed_at, u.org_id as real_org_id,
           rs.role as real_role, rs.is_active as real_active,
           t.role as acting_role, t.parent_id as acting_parent,
           case when ${p.ip}::inet is null then true
                else app.ip_allowed(u.org_id, ${p.ip}::inet, 'PANEL') end as ip_ok
      from users u
      join app.org_effective_state rs on rs.id = u.org_id
      left join organizations t on t.id = ${p.actingOrgId}::uuid
     where u.id = ${p.userId}::uuid`
    .execute(db)
    .catch(() => ({ rows: [] }));
  const row = r.rows[0];
  if (!row || !row.user_active) return { ok: false, reason: 'user' };
  if (!row.acting_role) return { ok: false, reason: 'org' };
  if (p.impersonating) {
    if (!mayImpersonate(row.real_role, row.real_org_id, { role: row.acting_role, parent_id: row.acting_parent })) {
      return { ok: false, reason: 'impersonation' };
    }
  } else if (p.actingOrgId !== row.real_org_id) {
    return { ok: false, reason: 'org' };
  }
  if (!row.real_active) return { ok: false, reason: 'suspended' };
  if (!row.ip_ok) return { ok: false, reason: 'ip' };
  return { ok: true, passwordChangedAt: row.password_changed_at, actingRole: row.acting_role, realOrgId: row.real_org_id };
}
