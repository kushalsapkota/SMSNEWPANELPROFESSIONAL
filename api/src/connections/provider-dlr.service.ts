import { Inject, Injectable, Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { raw } from 'express';
import { AppError } from '../common/errors';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
import { sha256Hex } from '../crypto/crypto.service';
import { DbService } from '../db/db.service';
import { EngineClient, EngineUnavailableError } from '../engine/engine-client.service';
import type { EngineProviderDlrEnvelope } from '../engine/engine.types';
import { RedisService } from '../redis/redis.module';
import { DLR_TOKEN_RE } from './http-adapters';

/** Mount path of the public provider callback (CONTRACTS: `POST|GET /v1/provider-dlr/:dlr_token`). */
export const PROVIDER_DLR_MOUNT = '/v1/provider-dlr';
/** Provider callbacks are small; anything larger is refused with 413 before it is buffered. */
export const PROVIDER_DLR_MAX_BODY = 64 * 1024;

/** Headers never forwarded to the engine (ours, or browser state that has no meaning to a provider callback). */
const DROP_HEADERS = new Set(['cookie', 'x-internal-token']);

/**
 * Express middleware (registered in configureApp BEFORE the json/urlencoded parsers): buffers the
 * raw body of provider callbacks, any content type, max 64KB. The json parser then skips these
 * requests (body already read), so the engine receives the provider's exact bytes.
 */
export function providerDlrRawBody() {
  const parser = raw({ type: () => true, limit: PROVIDER_DLR_MAX_BODY });
  return (req: Request, res: Response, next: NextFunction) =>
    parser(req, res, (err?: unknown) => {
      if (err) {
        const status = (err as { status?: number }).status ?? 400;
        res.status(status === 413 ? 413 : 400).type('text/plain').send(status === 413 ? 'Payload Too Large' : 'Bad Request');
        return;
      }
      next();
    });
}

/** INCR + EXPIRE in one round trip (same fixed-window pattern as the /v1 API key limiter). */
const WINDOW_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
return c`;

export type ProviderDlrOutcome =
  /** forwarded (engine accepted n), or token unknown / malformed (not forwarded): reply 200 OK */
  | { status: 200; forwarded: boolean; accepted?: number }
  /** rate limited: 429 so the provider retries later */
  | { status: 429 }
  /** engine unreachable / 5xx: 503 so the provider retries (the DLR is not lost) */
  | { status: 503 };

@Injectable()
export class ProviderDlrService {
  private readonly logger = new Logger(ProviderDlrService.name);
  private readonly tokenLimit: number;
  private readonly ipLimit: number;

  constructor(
    private readonly db: DbService,
    private readonly engine: EngineClient,
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.tokenLimit = config.PROVIDER_DLR_RATE_LIMIT;
    this.ipLimit = config.PROVIDER_DLR_IP_RATE_LIMIT;
  }

  async handle(token: string, req: Request, ip: string | null): Promise<ProviderDlrOutcome> {
    if (!(await this.allow(`rl:pdlr:ip:${ip ?? 'unknown'}`, this.ipLimit))) return { status: 429 };
    // Malformed or unknown tokens get the same 200 as real ones (no probing signal), but are never forwarded.
    if (!DLR_TOKEN_RE.test(token)) return { status: 200, forwarded: false };
    // Privileged pool: unauthenticated request; the unguessable token is the only credential.
    const conn = await this.db.privileged
      .selectFrom('upstream_connections')
      .select('id')
      .where('dlr_token', '=', token)
      .where('kind', '=', 'HTTP')
      .executeTakeFirst();
    if (!conn) return { status: 200, forwarded: false };
    if (!(await this.allow(`rl:pdlr:tok:${sha256Hex(token).slice(0, 24)}`, this.tokenLimit))) return { status: 429 };

    try {
      const r = await this.engine.providerDlr(token, envelopeOf(req));
      return { status: 200, forwarded: true, accepted: r?.accepted };
    } catch (e) {
      if (e instanceof AppError && e.status === 404) return { status: 200, forwarded: false };
      if (e instanceof EngineUnavailableError && e.upstreamStatus !== undefined && e.upstreamStatus < 500) {
        // The engine refused this payload (4xx): retrying the same bytes will not help.
        this.logger.warn(`provider DLR for connection ${conn.id} refused by the engine (HTTP ${e.upstreamStatus})`);
        return { status: 200, forwarded: false };
      }
      if (e instanceof AppError && e.status < 500) {
        this.logger.warn(`provider DLR for connection ${conn.id} refused by the engine: ${e.code}`);
        return { status: 200, forwarded: false };
      }
      // Never log the error message: it contains the request path (and so the token).
      this.logger.warn(`provider DLR for connection ${conn.id} could not be forwarded (engine unavailable)`);
      return { status: 503 };
    }
  }

  private async allow(key: string, limit: number): Promise<boolean> {
    const sec = Math.floor(Date.now() / 1000);
    try {
      return Number(await this.redis.client.eval(WINDOW_LUA, 1, `${key}:${sec}`, 2)) <= limit;
    } catch {
      return true; // fail open, like the /v1 limiter
    }
  }
}

/** The verbatim envelope of CONTRACTS (HTTP connections): method, query, lowercased headers, raw body. */
export function envelopeOf(req: Request): EngineProviderDlrEnvelope {
  const query: Record<string, string | string[]> = {};
  const qs = (req.originalUrl ?? req.url).split('?').slice(1).join('?');
  for (const [k, v] of new URLSearchParams(qs)) {
    const cur = query[k];
    if (cur === undefined) query[k] = v;
    else query[k] = Array.isArray(cur) ? [...cur, v] : [cur, v];
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (v === undefined || DROP_HEADERS.has(key)) continue;
    headers[key] = Array.isArray(v) ? v.join(', ') : v;
  }
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  return { method: req.method.toUpperCase(), query, headers, body_base64: body.toString('base64') };
}
