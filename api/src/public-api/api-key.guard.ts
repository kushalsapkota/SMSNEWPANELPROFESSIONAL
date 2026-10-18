import { CanActivate, ExecutionContext, Inject, Injectable, Logger, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { sql } from 'kysely';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
import { AuthedRequest } from '../common/decorators';
import { AppError } from '../common/errors';
import { clientIp } from '../common/request.util';
import { CryptoService } from '../crypto/crypto.service';
import { DbService } from '../db/db.service';
import { ApiRateLimiter } from './rate-limiter.service';

export const API_SCOPES = 'smsgw:apiScopes';
/** Any one of the listed API-key scopes grants access. */
export const RequireScope = (...scopes: string[]): MethodDecorator => SetMetadata(API_SCOPES, scopes);

export interface ApiKeyInfo {
  id: string;
  orgId: string;
  scopes: string[];
}
export interface ApiKeyRequest extends AuthedRequest {
  apiKey?: ApiKeyInfo;
}

const KEY_RE = /^sk_live_[A-Za-z0-9]{40}$/;

/** Bearer sk_live_… | X-API-Key | ?api_key= (legacy, GET only) — CONTRACTS §11. */
export function extractApiKey(req: ApiKeyRequest): string | null {
  const header = req.headers.authorization;
  const bearer = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  if (bearer) return bearer[1];
  const x = req.headers['x-api-key'];
  if (typeof x === 'string' && x.trim()) return x.trim();
  if (req.method === 'GET') {
    const q = (req.query as Record<string, unknown> | undefined)?.api_key;
    if (typeof q === 'string' && q.trim()) return q.trim();
  }
  return null;
}

/**
 * /v1 authentication (CONTRACTS §11), in order:
 *   key valid & not revoked/expired (401) → org effective state: active (ACCOUNT_SUSPENDED),
 *   can_send (SENDING_DISABLED), can_api (CHANNEL_DISABLED) → IP whitelist scope API/ALL
 *   (403 IP_NOT_ALLOWED) → per-key rate limit (429) → key scope (403).
 * Then `req.auth` is set to the key's org so TenantInterceptor runs the handler in a tenant
 * transaction as that org (RLS applies).
 *
 * Uses the privileged pool: the key IS the credential that identifies the tenant (auth flow,
 * no tenant context exists yet), and org_effective_state must see the reseller's real flags.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);
  private readonly touched = new Map<string, number>();

  constructor(
    private readonly db: DbService,
    private readonly crypto: CryptoService,
    private readonly limiter: ApiRateLimiter,
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<ApiKeyRequest>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const key = extractApiKey(req);
    if (!key) throw AppError.unauthorized('Missing API key: use "Authorization: Bearer sk_live_…" or the X-API-Key header');
    if (!KEY_RE.test(key)) throw AppError.unauthorized('Invalid API key');

    const ip = clientIp(req, this.config.TRUST_PROXY);
    const row = await this.db.privileged
      .selectFrom('api_keys as k')
      .innerJoin('app.org_effective_state as s', 's.id', 'k.org_id')
      .select([
        'k.id',
        'k.org_id',
        'k.scopes',
        'k.revoked_at',
        'k.expires_at',
        'k.created_by_user_id',
        's.role',
        's.is_active',
        's.can_send',
        's.can_api',
        sql<boolean>`app.ip_allowed(k.org_id, ${ip}::inet, 'API')`.as('ip_allowed'),
      ])
      .where('k.key_hash', '=', this.crypto.hashApiKey(key))
      .executeTakeFirst();

    if (!row) throw AppError.unauthorized('Invalid API key');
    if (row.revoked_at) throw AppError.unauthorized('API key has been revoked');
    if (row.expires_at && row.expires_at.getTime() <= Date.now()) throw AppError.unauthorized('API key has expired');
    if (row.role === 'SUPER_ADMIN') throw AppError.unauthorized('Invalid API key');

    if (!row.is_active) throw new AppError('ACCOUNT_SUSPENDED', 'Your account is suspended');
    if (!row.can_send) throw new AppError('SENDING_DISABLED', 'Sending is disabled for your account');
    if (!row.can_api) throw new AppError('CHANNEL_DISABLED', 'HTTP API access is disabled for your account');
    if (!row.ip_allowed) throw new AppError('IP_NOT_ALLOWED', `Requests from ${ip ?? 'this address'} are not allowed for this account`);

    const rate = await this.limiter.hit(row.id);
    res.setHeader('X-RateLimit-Limit', String(rate.limit));
    res.setHeader('X-RateLimit-Remaining', String(rate.remaining));
    if (!rate.allowed) {
      res.setHeader('Retry-After', '1');
      throw new AppError('RATE_LIMITED', `Rate limit of ${rate.limit} requests per second exceeded for this API key`);
    }

    const needed = this.reflector.get<string[] | undefined>(API_SCOPES, ctx.getHandler());
    if (needed && needed.length > 0 && !needed.some((s) => row.scopes.includes(s))) {
      throw new AppError('FORBIDDEN', `This API key lacks the required scope (${needed.join(' or ')})`);
    }

    this.touch(row.id);
    // userId: the key's creator. Nothing on /v1 writes audit rows, so a key whose creator
    // was deleted (created_by_user_id NULL) still works.
    req.auth = { userId: row.created_by_user_id ?? '', orgId: row.org_id, role: row.role };
    req.apiKey = { id: row.id, orgId: row.org_id, scopes: row.scopes };
    return true;
  }

  /** Throttled last_used_at: at most one write per key per API_KEY_TOUCH_INTERVAL_MS (per instance + in SQL). */
  private touch(keyId: string): void {
    const every = this.config.API_KEY_TOUCH_INTERVAL_MS;
    const now = Date.now();
    const last = this.touched.get(keyId);
    if (last !== undefined && now - last < every) return;
    if (this.touched.size > 50_000) this.touched.clear();
    this.touched.set(keyId, now);
    // Privileged: background bookkeeping for the auth flow, outside the tenant transaction.
    void this.db.privileged
      .updateTable('api_keys')
      .set({ last_used_at: sql`now()` })
      .where('id', '=', keyId)
      .where((eb) => eb.or([eb('last_used_at', 'is', null), eb('last_used_at', '<', sql<Date>`now() - make_interval(secs => ${every / 1000})`)]))
      .execute()
      .catch((e) => this.logger.warn(`last_used_at update failed: ${(e as Error).message}`));
  }
}
