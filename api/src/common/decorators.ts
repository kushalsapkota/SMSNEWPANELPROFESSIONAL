import { ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import type { OrgRole } from '../db/types';
import type { AuthContext } from './context';

export const IS_PUBLIC = 'smsgw:isPublic';
export const ROLES = 'smsgw:roles';
export const NO_REQUEST_TX = 'smsgw:noRequestTx';

/** Skips the JWT guard (login, refresh, health, and /v1 routes that use their own API-key guard). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

/** Restricts a route/controller to acting-org roles. */
export const Roles = (...roles: OrgRole[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES, roles);

/**
 * The handler manages its own transactions via `db.tenant()` (e.g. commit a ledger row
 * before calling the engine, or stream a response). The request context (auth, ip, ua) is
 * still available; `db.tenant()` then opens one transaction per call.
 */
export const NoRequestTransaction = (): MethodDecorator & ClassDecorator => SetMetadata(NO_REQUEST_TX, true);

export interface AuthedRequest extends Request {
  auth?: AuthContext;
}

/** Injects the acting AuthContext. */
export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.auth) throw new Error('@Auth() used on a route without authentication');
  return req.auth;
});
