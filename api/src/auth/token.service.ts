import { Inject, Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { Kysely, Transaction } from 'kysely';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
import { AuthContext } from '../common/context';
import { AppError } from '../common/errors';
import { CryptoService, sha256 } from '../crypto/crypto.service';
import { DB, ORG_ROLES, OrgRole } from '../db/types';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const ISSUER = 'smsgw-api';
const AUDIENCE = 'smsgw';

/** CONTRACTS §10 access-token claims. */
export interface AccessClaims {
  sub: string;
  org: string;
  role: OrgRole;
  imp?: string;
  oid?: string;
}

export interface VerifiedAccess extends AuthContext {
  issuedAt: number; // unix seconds
}

export interface IssuedRefresh {
  token: string;
  id: string;
  familyId: string;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

@Injectable()
export class TokenService {
  private readonly secret: string;
  private readonly refreshTtlMs: number;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly crypto: CryptoService,
  ) {
    this.secret = config.JWT_SECRET;
    this.refreshTtlMs = config.REFRESH_TOKEN_TTL_DAYS * 86_400_000;
  }

  signAccess(claims: AccessClaims): string {
    const payload: Record<string, unknown> = { org: claims.org, role: claims.role };
    if (claims.imp) payload.imp = claims.imp;
    if (claims.oid) payload.oid = claims.oid;
    return jwt.sign(payload, this.secret, {
      algorithm: 'HS256',
      subject: claims.sub,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      issuer: ISSUER,
      audience: AUDIENCE,
      jwtid: randomUUID(),
    });
  }

  verifyAccess(token: string): VerifiedAccess {
    let decoded: jwt.JwtPayload;
    try {
      const d = jwt.verify(token, this.secret, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE });
      if (typeof d === 'string') throw new Error('unexpected payload');
      decoded = d;
    } catch (e) {
      const expired = e instanceof jwt.TokenExpiredError;
      throw AppError.unauthorized(expired ? 'Access token expired' : 'Invalid access token');
    }
    const { sub, org, role, imp, oid, iat } = decoded as jwt.JwtPayload & Record<string, unknown>;
    if (
      typeof sub !== 'string' ||
      typeof org !== 'string' ||
      typeof role !== 'string' ||
      !(ORG_ROLES as readonly string[]).includes(role) ||
      typeof iat !== 'number'
    ) {
      throw AppError.unauthorized('Invalid access token');
    }
    return {
      userId: sub,
      orgId: org,
      role: role as OrgRole,
      impersonatorUserId: typeof imp === 'string' ? imp : undefined,
      originalOrgId: typeof oid === 'string' ? oid : undefined,
      issuedAt: iat,
    };
  }

  /** Inserts a refresh token row (privileged pool / transaction) and returns the opaque token. */
  async issueRefresh(
    db: Kysely<DB> | Transaction<DB>,
    opts: { userId: string; familyId?: string; impersonatedOrgId?: string | null; ip: string | null; userAgent: string | null },
  ): Promise<IssuedRefresh> {
    const token = this.crypto.randomToken(32);
    const familyId = opts.familyId ?? randomUUID();
    const row = await db
      .insertInto('refresh_tokens')
      .values({
        user_id: opts.userId,
        family_id: familyId,
        token_hash: sha256(token),
        impersonated_org_id: opts.impersonatedOrgId ?? null,
        expires_at: new Date(Date.now() + this.refreshTtlMs),
        created_ip: opts.ip,
        user_agent: opts.userAgent,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { token, id: row.id, familyId };
  }

  hashRefresh(token: string): Buffer {
    return sha256(token);
  }

  pair(access: string, refresh: string): TokenPair {
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_SECONDS };
  }
}
