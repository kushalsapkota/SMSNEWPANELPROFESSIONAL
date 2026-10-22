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
import { evaluateSession, mayImpersonate } from './session-check';
import { LoginRateLimiter } from './login-rate-limiter.service';
import { TokenPair, TokenService } from './token.service';

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;
export const RECOVERY_CODE_COUNT = 10;

const totp = authenticator.clone({ window: 1 });
const TOTP_STEP_SECONDS = 30;

/** Current TOTP time step (RFC 6238, T0 = 0, 30s). */
function currentTotpStep(): number {
  return Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
}

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
    private readonly loginLimiter: LoginRateLimiter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // -------------------------------------------------------------------------
  // Login
  // -------------------------------------------------------------------------

  async login(email: string, password: string, totpCode: string | undefined) {
    const db = this.db.privileged;
    const meta = currentMeta();
    // Per-IP throttle before any work, so credential spraying and enumeration are both capped
    // and the per-account lockout cannot be weaponised at volume from one source.
    const rate = await this.loginLimiter.hit(meta.ip);
    if (!rate.allowed) {
      throw new AppError('RATE_LIMITED', 'Too many login attempts from your network; please wait and try again', {
        retry_after_seconds: rate.retryAfterSeconds,
      });
    }
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

  /**
   * TOTP code (±1 step, each step accepted at most once: users.totp_last_step), or a
   * single-use recovery code (consumed atomically).
   */
  private async verifySecondFactor(user: User, code: string): Promise<boolean> {
    const c = code.replace(/\s+/g, '');
    if (/^[0-9]{6}$/.test(c)) {
      if (!user.totp_secret_enc) return false;
      return this.acceptTotp(user.id, c, this.crypto.decrypt(user.totp_secret_enc));
    }
    const h = this.crypto.hashRecoveryCode(c);
    const r = await sql<{ id: string }>`
      update users set totp_recovery_hashes = array_remove(totp_recovery_hashes, ${h})
       where id = ${user.id} and ${h} = any(totp_recovery_hashes)
   returning id`.execute(this.db.privileged);
    return r.rows.length === 1;
  }

  /**
   * Checks a 6-digit TOTP and records its time step; a step at or before the last accepted
   * one is refused, so an observed code can't be replayed within its validity window.
   */
  private async acceptTotp(userId: string, code: string, secret: string): Promise<boolean> {
    const delta = totp.checkDelta(code, secret);
    if (delta === null) return false;
    const step = currentTotpStep() + delta;
    const r = await sql<{ id: string }>`
      update users set totp_last_step = ${step}
       where id = ${userId} and (totp_last_step is null or totp_last_step < ${step})
   returning id`.execute(this.db.privileged);
    return r.rows.length === 1;
  }

  /**
   * Current password / 2FA re-checks inside a session (password change, 2FA disable): a locked
   * account is refused, and every failure counts toward the same lockout as login.
   */
  private async reverify(user: User, kind: 'password' | 'totp', check: () => Promise<boolean>): Promise<boolean> {
    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      throw AppError.unauthorized('Account temporarily locked after too many failed attempts', {
        locked_until: user.locked_until.toISOString(),
      });
    }
    if (await check()) {
      if (user.failed_login_count > 0) {
        await this.db.privileged.updateTable('users').set({ failed_login_count: 0 }).where('id', '=', user.id).execute();
      }
      return true;
    }
    await this.registerFailure(user, kind);
    return false;
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
      // Same checks as every request (real org active, impersonation still allowed, PANEL IP).
      const v = await evaluateSession(trx, {
        userId: user.id,
        actingOrgId: row.impersonated_org_id ?? user.org_id,
        impersonating: Boolean(row.impersonated_org_id),
        ip: meta.ip,
      });
      if (!v.ok) {
        if (v.reason === 'suspended') return { kind: 'suspended' as const };
        // A refresh from outside the whitelist, or an impersonation that is no longer allowed:
        // the token is not usable anymore, end the whole session family.
        if (v.reason === 'ip' || v.reason === 'impersonation') {
          await trx
            .updateTable('refresh_tokens')
            .set({ revoked_at: new Date(), revoked_reason: v.reason === 'ip' ? 'ip_not_allowed' : 'impersonation_not_allowed' })
            .where('family_id', '=', row.family_id)
            .where('revoked_at', 'is', null)
            .execute();
          return { kind: v.reason };
        }
        return { kind: 'invalid' as const };
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
      case 'ip':
        throw new AppError('IP_NOT_ALLOWED', 'Panel access is not allowed from this IP address');
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
      brand_name: await this.effectiveBrand(org),
    };
  }

  /**
   * Whitelabel brand shown in the panel (CONTRACTS-CHANGES web #1): the org's own brand_name,
   * else (a client) its reseller's. Privileged: a client can't read its reseller's row under RLS.
   */
  private async effectiveBrand(org: Organization): Promise<string | null> {
    if (org.brand_name) return org.brand_name;
    if (org.role !== 'CLIENT' || !org.parent_id) return null;
    const parent = await this.db.privileged.selectFrom('organizations').select('brand_name').where('id', '=', org.parent_id).executeTakeFirst();
    return parent?.brand_name ?? null;
  }

  /**
   * Public login-page branding for a reseller's whitelabel domain (`organizations.whitelabel_domain`,
   * case-insensitive, port ignored). Only an ACTIVE reseller's brand is revealed; anything else
   * → `{brand_name: null}` (the default brand).
   */
  async branding(rawHost: string | undefined): Promise<{ host: string | null; brand_name: string | null; reseller: boolean }> {
    const host = normalizeHost(rawHost);
    if (!host) return { host: null, brand_name: null, reseller: false };
    const org = await this.db.privileged
      .selectFrom('organizations')
      .select(['name', 'brand_name'])
      .where('whitelabel_domain', '=', host)
      .where('role', '=', 'RESELLER')
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    return { host, brand_name: org ? org.brand_name ?? org.name : null, reseller: Boolean(org) };
  }

  /** Changing the password ends every other session (refresh tokens revoked, older access tokens rejected). */
  async changePassword(auth: AuthContext, current: string, next: string): Promise<TokenPair> {
    if (auth.impersonatorUserId) throw AppError.forbidden('Stop impersonating before changing your password');
    const user = await this.db.privileged.selectFrom('users').selectAll().where('id', '=', auth.userId).executeTakeFirstOrThrow();
    if (!(await this.reverify(user, 'password', () => this.crypto.verifyPassword(user.password_hash, current)))) {
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
      .set({ totp_secret_enc: this.crypto.encryptToBytes(secret), totp_recovery_hashes: [], totp_last_step: null })
      .where('id', '=', user.id)
      .execute();
    return { secret, otpauth_url: totp.keyuri(user.email, this.config.TOTP_ISSUER, secret) };
  }

  async totpEnable(auth: AuthContext, code: string): Promise<{ recovery_codes: string[] }> {
    this.denyWhileImpersonating(auth);
    const user = await this.db.privileged.selectFrom('users').selectAll().where('id', '=', auth.userId).executeTakeFirstOrThrow();
    if (user.totp_enabled) throw AppError.conflict('Two-factor authentication is already enabled');
    if (!user.totp_secret_enc) throw AppError.invalid('Call /api/auth/totp/setup first');
    if (!(await this.acceptTotp(user.id, code.trim(), this.crypto.decrypt(user.totp_secret_enc)))) throw AppError.invalid('Invalid two-factor code');
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
    if (!(await this.reverify(user, 'totp', () => this.verifySecondFactor(user, code)))) throw AppError.invalid('Invalid two-factor code');
    await this.db.privileged
      .updateTable('users')
      .set({ totp_enabled: false, totp_secret_enc: null, totp_recovery_hashes: [], totp_last_step: null })
      .where('id', '=', user.id)
      .execute();
    await this.audit.recordAs({ userId: user.id, orgId: user.org_id }, { action: 'auth.totp_disable', entityType: 'user', entityId: user.id, targetOrgId: user.org_id });
  }

  // -------------------------------------------------------------------------
  // Impersonation
  // -------------------------------------------------------------------------

  /**
   * Parent-only (CONTRACTS §10): admin -> its resellers, reseller -> its clients. Decided on the
   * user's REAL org, which must be active. The admin reaches clients only through a reseller
   * session (SUPER_ADMIN manages resellers only).
   */
  async impersonate(auth: AuthContext, targetOrgId: string): Promise<TokenPair> {
    const meta = currentMeta();
    const user = await this.db.privileged.selectFrom('users').selectAll().where('id', '=', auth.userId).executeTakeFirstOrThrow();
    const realOrg = await this.loadOrgOrFail(user.org_id);
    const target = await this.db.privileged.selectFrom('organizations').selectAll().where('id', '=', targetOrgId).executeTakeFirst();
    if (!target) throw AppError.notFound('Organization');
    if (target.id === realOrg.id) throw AppError.invalid('Use /api/auth/impersonate/stop to return to your own organization');
    await this.assertOrgActive(realOrg.id);
    if (!mayImpersonate(realOrg.role, realOrg.id, target)) {
      throw AppError.forbidden('You may only impersonate organizations directly below yours (admin: resellers; reseller: its clients)');
    }

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

/** "Panel.Example.com:443" → "panel.example.com"; null for anything that isn't a plausible host name. */
export function normalizeHost(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let h = raw.trim().toLowerCase();
  if (h.startsWith('[')) return null; // IPv6 literals never carry a whitelabel domain
  h = h.replace(/:\d+$/, '').replace(/\.$/, '');
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(h) ? h : null;
}
