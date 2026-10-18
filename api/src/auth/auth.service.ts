import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { authenticator } from 'otplib';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
import { AuditService } from '../audit/audit.service';
import { AuthContext, currentMeta } from '../common/context';
import { AppError } from '../common/errors';
import { CryptoService } from '../crypto/crypto.service';
import { DbService } from '../db/db.service';
import type { Organization, User } from '../db/types';
import { publicOrg, publicUser } from '../orgs/org.dto';
import { TokenPair, TokenService } from './token.service';

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;
export const RECOVERY_CODE_COUNT = 10;

const totp = authenticator.clone({ window: 1 });

/**
 * All auth flows use the privileged pool (CONTRACTS: auth flows only): they run before a
 * tenant context exists or touch the caller's own user row / refresh tokens.
 */
@Injectable()
export class AuthService {
  /** Equalises timing for unknown emails (argon2 verify against a throwaway hash). */
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly db: DbService,
    private readonly crypto: CryptoService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // -------------------------------------------------------------------------
  // Login
  // -------------------------------------------------------------------------

  async login(email: string, password: string, totpCode: string | undefined) {
    const db = this.db.privileged;
    const meta = currentMeta();
    const user = await db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst();
    if (!user) {
      this.dummyHash ??= this.crypto.hashPassword(this.crypto.randomToken(16));
      await this.crypto.verifyPassword(await this.dummyHash, password);
      throw AppError.unauthorized('Invalid email or password');
    }
    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      throw AppError.unauthorized('Account temporarily locked after too many failed attempts', {
        locked_until: user.locked_until.toISOString(),
      });
    }
    const passwordOk = await this.crypto.verifyPassword(user.password_hash, password);
    if (!passwordOk || !user.is_active) {
      if (!passwordOk) await this.registerFailure(user, 'password');
      throw AppError.unauthorized('Invalid email or password');
    }

    if (user.totp_enabled) {
      if (!totpCode) return { requires_totp: true as const };
      const ok = await this.verifySecondFactor(user, totpCode);
      if (!ok) {
        await this.registerFailure(user, 'totp');
        throw AppError.unauthorized('Invalid two-factor code');
      }
    }

    const org = await this.loadOrgOrFail(user.org_id);
    await this.assertOrgActive(org.id);
    if (meta.ip) {
      const r = await sql<{ ok: boolean }>`select app.ip_allowed(${org.id}::uuid, ${meta.ip}::inet, 'PANEL') as ok`.execute(db);
      if (!r.rows[0]?.ok) throw new AppError('IP_NOT_ALLOWED', 'Panel access is not allowed from this IP address');
    }

    const updated = await db
      .updateTable('users')
      .set({ failed_login_count: 0, locked_until: null, last_login_at: new Date(), last_login_ip: meta.ip })
      .where('id', '=', user.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    const pair = await this.issuePair(updated, null);
    await this.audit.recordAs(
      { userId: user.id, orgId: org.id },
      { action: 'auth.login', entityType: 'user', entityId: user.id, targetOrgId: org.id },
    );
    return { ...pair, user: publicUser(updated), org: publicOrg(org) };
  }

  /** Atomic increment; the 5th consecutive failure locks the account for 15 minutes. */
  private async registerFailure(user: User, kind: 'password' | 'totp'): Promise<void> {
    const r = await sql<{ locked_until: Date | null; locked_now: boolean }>`
      update users
         set failed_login_count = case when failed_login_count + 1 >= ${MAX_FAILED_LOGINS} then 0 else failed_login_count + 1 end,
             locked_until       = case when failed_login_count + 1 >= ${MAX_FAILED_LOGINS}
                                       then now() + make_interval(mins => ${LOCKOUT_MINUTES}) else locked_until end
       where id = ${user.id}
   returning locked_until, (locked_until is not null and locked_until > now()) as locked_now`.execute(this.db.privileged);
    const row = r.rows[0];
    if (row?.locked_now) {
      await this.audit.recordAs(
        { userId: user.id, orgId: user.org_id },
        { action: 'auth.lockout', entityType: 'user', entityId: user.id, targetOrgId: user.org_id, after: { reason: kind, locked_until: row.locked_until } },
      );
      throw AppError.unauthorized('Too many failed attempts; account locked for 15 minutes', {
        locked_until: row.locked_until?.toISOString(),
      });
    }
  }

  /** TOTP code, or a single-use recovery code (consumed atomically). */
  private async verifySecondFactor(user: User, code: string): Promise<boolean> {
    const c = code.replace(/\s+/g, '');
    if (/^[0-9]{6}$/.test(c)) {
      if (!user.totp_secret_enc) return false;
      return totp.check(c, this.crypto.decrypt(user.totp_secret_enc));
    }
    const h = this.crypto.hashRecoveryCode(c);
    const r = await sql<{ id: string }>`
      update users set totp_recovery_hashes = array_remove(totp_recovery_hashes, ${h})
       where id = ${user.id} and ${h} = any(totp_recovery_hashes)
   returning id`.execute(this.db.privileged);
    return r.rows.length === 1;
  }

  // -------------------------------------------------------------------------
  // Refresh / logout
  // -------------------------------------------------------------------------

  async refresh(refreshToken: string): Promise<TokenPair> {
    const meta = currentMeta();
    const hash = this.tokens.hashRefresh(refreshToken);
    const outcome = await this.db.privileged.transaction().execute(async (trx) => {
      const row = await trx.selectFrom('refresh_tokens').selectAll().where('token_hash', '=', hash).forUpdate().executeTakeFirst();
      if (!row) return { kind: 'invalid' as const };
      if (row.revoked_at || row.replaced_by) {
        await trx
          .updateTable('refresh_tokens')
          .set({ revoked_at: new Date(), revoked_reason: 'reuse_detected' })
          .where('family_id', '=', row.family_id)
          .where('revoked_at', 'is', null)
          .execute();
        return { kind: 'reuse' as const, row };
      }
      if (row.expires_at.getTime() <= Date.now()) return { kind: 'expired' as const };

      const user = await trx.selectFrom('users').selectAll().where('id', '=', row.user_id).executeTakeFirst();
      if (!user || !user.is_active) return { kind: 'invalid' as const };
      if (!row.impersonated_org_id) {
        const st = await trx.selectFrom('app.org_effective_state').select('is_active').where('id', '=', user.org_id).executeTakeFirst();
        if (!st?.is_active) return { kind: 'suspended' as const };
      }
      const next = await this.tokens.issueRefresh(trx, {
        userId: user.id,
        familyId: row.family_id,
        impersonatedOrgId: row.impersonated_org_id,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      await trx
        .updateTable('refresh_tokens')
        .set({ replaced_by: next.id, revoked_at: new Date(), revoked_reason: 'rotated' })
        .where('id', '=', row.id)
        .execute();
      const access = await this.accessFor(user, row.impersonated_org_id, trx);
      return { kind: 'ok' as const, pair: this.tokens.pair(access, next.token) };
    });

    switch (outcome.kind) {
      case 'ok':
        return outcome.pair;
      case 'reuse': {
        const user = await this.db.privileged.selectFrom('users').select(['id', 'org_id']).where('id', '=', outcome.row.user_id).executeTakeFirst();
        await this.audit.recordAs(
          { userId: outcome.row.user_id, orgId: user?.org_id ?? null },
          { action: 'auth.refresh_reuse_detected', entityType: 'refresh_token_family', entityId: outcome.row.family_id, targetOrgId: user?.org_id ?? null },
        );
        throw AppError.unauthorized('Refresh token reuse detected; all sessions in this family were revoked');
      }
      case 'expired':
        throw AppError.unauthorized('Refresh token expired');
      case 'suspended':
        throw AppError.suspended();
      default:
        throw AppError.unauthorized('Invalid refresh token');
    }
  }

  async logout(refreshToken: string): Promise<void> {
    const row = await this.db.privileged
      .selectFrom('refresh_tokens')
      .select(['family_id'])
      .where('token_hash', '=', this.tokens.hashRefresh(refreshToken))
      .executeTakeFirst();
    if (!row) return;
    await this.db.privileged
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date(), revoked_reason: 'logout' })
      .where('family_id', '=', row.family_id)
      .where('revoked_at', 'is', null)
      .execute();
  }

  // -------------------------------------------------------------------------
  // Me / password
  // -------------------------------------------------------------------------

  async me(auth: AuthContext) {
    const user = await this.db.privileged.selectFrom('users').selectAll().where('id', '=', auth.userId).executeTakeFirstOrThrow();
    const org = await this.loadOrgOrFail(auth.orgId);
    const original = auth.originalOrgId ? await this.loadOrgOrFail(auth.originalOrgId) : null;
    return {
      user: publicUser(user),
      org: publicOrg(org),
      impersonating: Boolean(auth.impersonatorUserId),
      ...(original ? { original_org: publicOrg(original) } : {}),
    };
  }

  /** Changing the password ends every other session (refresh tokens revoked, older access tokens rejected). */
  async changePassword(auth: AuthContext, current: string, next: string): Promise<TokenPair> {
    if (auth.impersonatorUserId) throw AppError.forbidden('Stop impersonating before changing your password');
    const user = await this.db.privileged.selectFrom('users').selectAll().where('id', '=', auth.userId).executeTakeFirstOrThrow();
    if (!(await this.crypto.verifyPassword(user.password_hash, current))) {
      throw AppError.invalid('Current password is incorrect', { field: 'current_password' });
    }
    if (current === next) throw AppError.invalid('New password must differ from the current password');
    const hash = await this.crypto.hashPassword(next);
    const updated = await this.db.privileged.transaction().execute(async (trx) => {
      const u = await trx
        .updateTable('users')
        .set({ password_hash: hash, password_changed_at: new Date(Math.floor(Date.now() / 1000) * 1000) })
        .where('id', '=', user.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('refresh_tokens')
        .set({ revoked_at: new Date(), revoked_reason: 'password_change' })
        .where('user_id', '=', user.id)
        .where('revoked_at', 'is', null)
        .execute();
      return u;
    });
    await this.audit.recordAs({ userId: user.id, orgId: user.org_id }, { action: 'auth.password_change', entityType: 'user', entityId: user.id, targetOrgId: user.org_id });
    return this.issuePair(updated, null);
  }

  // -------------------------------------------------------------------------
  // TOTP
  // -------------------------------------------------------------------------

  async totpSetup(auth: AuthContext): Promise<{ secret: string; otpauth_url: string }> {
    this.denyWhileImpersonating(auth);
    const user = await this.db.privileged.selectFrom('users').selectAll().where('id', '=', auth.userId).executeTakeFirstOrThrow();
    if (user.totp_enabled) throw AppError.conflict('Two-factor authentication is already enabled');
    const secret = totp.generateSecret(20);
    await this.db.privileged
      .updateTable('users')
      .set({ totp_secret_enc: this.crypto.encryptToBytes(secret), totp_recovery_hashes: [] })
      .where('id', '=', user.id)
      .execute();
    return { secret, otpauth_url: totp.keyuri(user.email, this.config.TOTP_ISSUER, secret) };
  }

  async totpEnable(auth: AuthContext, code: string): Promise<{ recovery_codes: string[] }> {
    this.denyWhileImpersonating(auth);
    const user = await this.db.privileged.selectFrom('users').selectAll().where('id', '=', auth.userId).executeTakeFirstOrThrow();
    if (user.totp_enabled) throw AppError.conflict('Two-factor authentication is already enabled');
    if (!user.totp_secret_enc) throw AppError.invalid('Call /api/auth/totp/setup first');
    if (!totp.check(code.trim(), this.crypto.decrypt(user.totp_secret_enc))) throw AppError.invalid('Invalid two-factor code');
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => this.crypto.generateRecoveryCode());
    await this.db.privileged
      .updateTable('users')
      .set({ totp_enabled: true, totp_recovery_hashes: codes.map((c) => this.crypto.hashRecoveryCode(c)) })
      .where('id', '=', user.id)
      .execute();
    await this.audit.recordAs({ userId: user.id, orgId: user.org_id }, { action: 'auth.totp_enable', entityType: 'user', entityId: user.id, targetOrgId: user.org_id });
    return { recovery_codes: codes };
  }

  async totpDisable(auth: AuthContext, code: string): Promise<void> {
    this.denyWhileImpersonating(auth);
    const user = await this.db.privileged.selectFrom('users').selectAll().where('id', '=', auth.userId).executeTakeFirstOrThrow();
    if (!user.totp_enabled) throw AppError.invalid('Two-factor authentication is not enabled');
    if (!(await this.verifySecondFactor(user, code))) throw AppError.invalid('Invalid two-factor code');
    await this.db.privileged
      .updateTable('users')
      .set({ totp_enabled: false, totp_secret_enc: null, totp_recovery_hashes: [] })
      .where('id', '=', user.id)
      .execute();
    await this.audit.recordAs({ userId: user.id, orgId: user.org_id }, { action: 'auth.totp_disable', entityType: 'user', entityId: user.id, targetOrgId: user.org_id });
  }

  // -------------------------------------------------------------------------
  // Impersonation
  // -------------------------------------------------------------------------

  /** Parent-only: admin -> reseller/client, reseller -> its clients. Decided on the user's REAL org. */
  async impersonate(auth: AuthContext, targetOrgId: string): Promise<TokenPair> {
    const meta = currentMeta();
    const user = await this.db.privileged.selectFrom('users').selectAll().where('id', '=', auth.userId).executeTakeFirstOrThrow();
    const realOrg = await this.loadOrgOrFail(user.org_id);
    const target = await this.db.privileged.selectFrom('organizations').selectAll().where('id', '=', targetOrgId).executeTakeFirst();
    if (!target) throw AppError.notFound('Organization');
    if (target.id === realOrg.id) throw AppError.invalid('Use /api/auth/impersonate/stop to return to your own organization');

    let allowed = false;
    if (realOrg.role === 'SUPER_ADMIN') allowed = target.role === 'RESELLER' || target.role === 'CLIENT';
    else if (realOrg.role === 'RESELLER') allowed = target.role === 'CLIENT' && target.parent_id === realOrg.id;
    if (!allowed) throw AppError.forbidden('You may only impersonate organizations below yours');

    const refresh = await this.tokens.issueRefresh(this.db.privileged, {
      userId: user.id,
      impersonatedOrgId: target.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    const access = this.tokens.signAccess({ sub: user.id, org: target.id, role: target.role, imp: user.id, oid: realOrg.id });
    await this.audit.recordAs(
      { userId: user.id, orgId: realOrg.id, impersonatorUserId: user.id },
      {
        action: 'auth.impersonate',
        entityType: 'organization',
        entityId: target.id,
        targetOrgId: target.id,
        before: auth.impersonatorUserId ? { impersonating: auth.orgId } : null,
        after: { impersonating: target.id, role: target.role },
      },
    );
    return this.tokens.pair(access, refresh.token);
  }

  async stopImpersonation(auth: AuthContext): Promise<TokenPair> {
    if (!auth.impersonatorUserId) throw AppError.invalid('You are not impersonating anyone');
    const user = await this.db.privileged.selectFrom('users').selectAll().where('id', '=', auth.userId).executeTakeFirstOrThrow();
    await this.db.privileged
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date(), revoked_reason: 'impersonation_stopped' })
      .where('user_id', '=', user.id)
      .where('impersonated_org_id', 'is not', null)
      .where('revoked_at', 'is', null)
      .execute();
    await this.audit.recordAs(
      { userId: user.id, orgId: user.org_id, impersonatorUserId: user.id },
      { action: 'auth.impersonate_stop', entityType: 'organization', entityId: auth.orgId, targetOrgId: auth.orgId },
    );
    return this.issuePair(user, null);
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private denyWhileImpersonating(auth: AuthContext): void {
    if (auth.impersonatorUserId) throw AppError.forbidden('Not allowed while impersonating');
  }

  private async loadOrgOrFail(id: string): Promise<Organization> {
    const org = await this.db.privileged.selectFrom('organizations').selectAll().where('id', '=', id).executeTakeFirst();
    if (!org) throw AppError.unauthorized('Organization no longer exists');
    return org;
  }

  private async assertOrgActive(orgId: string): Promise<void> {
    const st = await this.db.privileged.selectFrom('app.org_effective_state').select('is_active').where('id', '=', orgId).executeTakeFirst();
    if (!st?.is_active) throw AppError.suspended();
  }

  private async accessFor(user: User, impersonatedOrgId: string | null, db = this.db.privileged): Promise<string> {
    if (!impersonatedOrgId) {
      const org = await db.selectFrom('organizations').select(['id', 'role']).where('id', '=', user.org_id).executeTakeFirstOrThrow();
      return this.tokens.signAccess({ sub: user.id, org: org.id, role: org.role });
    }
    const target = await db.selectFrom('organizations').select(['id', 'role']).where('id', '=', impersonatedOrgId).executeTakeFirstOrThrow();
    return this.tokens.signAccess({ sub: user.id, org: target.id, role: target.role, imp: user.id, oid: user.org_id });
  }

  private async issuePair(user: User, impersonatedOrgId: string | null): Promise<TokenPair> {
    const meta = currentMeta();
    const refresh = await this.tokens.issueRefresh(this.db.privileged, {
      userId: user.id,
      impersonatedOrgId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    const access = await this.accessFor(user, impersonatedOrgId);
    return this.tokens.pair(access, refresh.token);
  }
}
