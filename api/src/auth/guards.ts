import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
import { AppError } from '../common/errors';
import { AuthedRequest, IS_PUBLIC, ROLES } from '../common/decorators';
import { clientIp, proxyTrustOf } from '../common/request.util';
import { DbService } from '../db/db.service';
import type { OrgRole } from '../db/types';
import { evaluateSession } from './session-check';
import { TokenService } from './token.service';

/**
 * Global guard: verifies the Bearer access JWT and re-validates it against the DB on every
 * request (see evaluateSession): user active, token issued after the last password change,
 * the user's REAL org active (also while impersonating), the impersonation still allowed, and
 * the client IP inside the real org's PANEL/ALL whitelist. Uses the privileged pool: this is
 * part of the auth flow and runs before any tenant context exists.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    const m = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    if (!m) throw AppError.unauthorized('Missing Bearer access token');
    if (m[1].startsWith('sk_live_')) throw AppError.unauthorized('API keys are only accepted on /v1 endpoints');
    const claims = this.tokens.verifyAccess(m[1]);
    const impersonating = Boolean(claims.impersonatorUserId);
    if (impersonating && claims.impersonatorUserId !== claims.userId) throw AppError.unauthorized('Invalid impersonation token');

    const v = await evaluateSession(this.db.privileged, {
      userId: claims.userId,
      actingOrgId: claims.orgId,
      impersonating,
      ip: clientIp(req, proxyTrustOf(this.config)),
    });
    if (!v.ok) {
      switch (v.reason) {
        case 'user':
          throw AppError.unauthorized('User is disabled or no longer exists');
        case 'suspended':
          throw AppError.suspended();
        case 'ip':
          throw new AppError('IP_NOT_ALLOWED', 'Panel access is not allowed from this IP address');
        case 'impersonation':
          throw AppError.unauthorized('Invalid impersonation token');
        default:
          throw AppError.unauthorized('Invalid access token');
      }
    }
    if (claims.issuedAt * 1000 < Math.floor(v.passwordChangedAt.getTime() / 1000) * 1000) {
      throw AppError.unauthorized('Session ended by a password change; please log in again');
    }
    if (v.actingRole !== claims.role) throw AppError.unauthorized('Invalid access token');
    if (impersonating && claims.originalOrgId !== v.realOrgId) throw AppError.unauthorized('Invalid impersonation token');

    req.auth = {
      userId: claims.userId,
      orgId: claims.orgId,
      role: claims.role,
      impersonatorUserId: claims.impersonatorUserId,
      originalOrgId: claims.originalOrgId,
    };
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<OrgRole[] | undefined>(ROLES, [ctx.getHandler(), ctx.getClass()]);
    if (!roles || roles.length === 0) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.auth) return true; // public route
    if (!roles.includes(req.auth.role)) throw AppError.forbidden(`This endpoint requires role ${roles.join(' or ')}`);
    return true;
  }
}
