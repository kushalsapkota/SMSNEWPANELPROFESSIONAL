import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../common/errors';
import { AuthedRequest, IS_PUBLIC, ROLES } from '../common/decorators';
import { DbService } from '../db/db.service';
import type { OrgRole } from '../db/types';
import { TokenService } from './token.service';

/**
 * Global guard: verifies the Bearer access JWT and re-validates it against the DB
 * (user active, token issued after the last password change, acting org active unless
 * impersonating). Uses the privileged pool: this is part of the auth flow and runs
 * before any tenant context exists.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly db: DbService,
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

    const row = await this.db.privileged
      .selectFrom('users as u')
      .innerJoin('app.org_effective_state as s', (j) => j.on('s.id', '=', claims.orgId))
      .select(['u.is_active', 'u.password_changed_at', 'u.org_id', 's.is_active as org_active', 's.role as org_role'])
      .where('u.id', '=', claims.userId)
      .executeTakeFirst()
      .catch(() => undefined);

    if (!row || !row.is_active) throw AppError.unauthorized('User is disabled or no longer exists');
    if (claims.issuedAt * 1000 < Math.floor(row.password_changed_at.getTime() / 1000) * 1000) {
      throw AppError.unauthorized('Session ended by a password change; please log in again');
    }
    if (row.org_role !== claims.role) throw AppError.unauthorized('Invalid access token');
    if (claims.impersonatorUserId) {
      if (claims.impersonatorUserId !== claims.userId || claims.originalOrgId !== row.org_id) {
        throw AppError.unauthorized('Invalid impersonation token');
      }
    } else {
      if (claims.orgId !== row.org_id) throw AppError.unauthorized('Invalid access token');
      if (!row.org_active) throw AppError.suspended();
    }

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
