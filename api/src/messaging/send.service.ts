import { Injectable } from '@nestjs/common';
import { AppError, isErrorCode } from '../common/errors';
import { sha256Hex } from '../crypto/crypto.service';
import { EngineClient, EngineUnavailableError } from '../engine/engine-client.service';
import type { EngineBatchResult, EngineSubmitOk, EngineSubmitRequest } from '../engine/engine.types';
import { RedisService } from '../redis/redis.module';
import { normalizeDestination, splitRecipients } from './msisdn';
import { newUuidV7 } from './uuidv7';

/** CONTRACTS §11 / §10 send result rows. */
export interface SendOk {
  to: string;
  message_id: string;
  status: string;
  parts: number;
  cost_micros: number;
}
export interface SendErr {
  to: string;
  error_code: string;
  message: string;
}
export type SendResultRow = SendOk | SendErr;

export interface SendRequest {
  orgId: string;
  channel: 'HTTP' | 'WEB';
  to: string | string[];
  from: string;
  text: string;
  clientRef?: string;
  routeId?: string;
  campaignId?: string;
  test?: boolean;
  /**
   * `Idempotency-Key` header: a retry with the same key (24h) reuses the message ids of the
   * first attempt, so the engine never charges / sends a recipient twice (it answers a repeated
   * id with the original acceptance). Same key + a different request → 409 CONFLICT.
   */
  idempotencyKey?: string;
}

/** How long an Idempotency-Key is remembered (per org). */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 3600;
/** Header value rules: 1-255 visible ASCII characters. */
export const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,255}$/;

/** Validates an `Idempotency-Key` header value (undefined when absent). */
export function parseIdempotencyKey(raw: string | string[] | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const v = (Array.isArray(raw) ? raw[0] : raw).trim();
  if (!IDEMPOTENCY_KEY_RE.test(v)) throw AppError.invalid('Idempotency-Key must be 1-255 visible ASCII characters', { field: 'Idempotency-Key' });
  return v;
}

export const MAX_RECIPIENTS = 1000;
/** Engine /submit/batch limit (CONTRACTS §5). */
export const ENGINE_BATCH_MAX = 1000;

export function isSubmitOk(r: EngineBatchResult): r is EngineSubmitOk {
  return typeof (r as EngineSubmitOk).message_id === 'string';
}

function okRow(to: string, r: EngineSubmitOk): SendOk {
  return { to, message_id: r.message_id, status: r.status, parts: r.parts, cost_micros: r.cost_micros };
}

/**
 * Fan-out of one send request to the engine (HTTP API, web quick send).
 *   - destinations are normalised locally (same rules as the engine); invalid ones never
 *     reach the engine and come back as INVALID_DESTINATION rows;
 *   - one recipient -> POST /submit, and a rejection is thrown (4xx/422 with the engine's
 *     error body, CONTRACTS §11 "single-recipient requests that fail entirely");
 *   - several -> POST /submit/batch (chunks of ≤1000), always 200 with one row per input,
 *     in input order.
 */
@Injectable()
export class SendService {
  constructor(
    private readonly engine: EngineClient,
    private readonly redis: RedisService,
  ) {}

  async send(req: SendRequest): Promise<{ messages: SendResultRow[] }> {
    const recipients = splitRecipients(req.to);
    if (recipients.length === 0) throw AppError.invalid('At least one recipient is required', { field: 'to' });
    if (recipients.length > MAX_RECIPIENTS) {
      throw AppError.invalid(`At most ${MAX_RECIPIENTS} recipients per request`, { field: 'to', count: recipients.length });
    }

    const ids = await this.messageIds(req, recipients);
    const base = (destination: string, index: number): EngineSubmitRequest => ({
      ...(ids ? { message_id: ids[index] } : {}),
      org_id: req.orgId,
      channel: req.channel,
      source: req.from,
      destination,
      text: req.text,
      ...(req.clientRef !== undefined ? { client_ref: req.clientRef } : {}),
      ...(req.routeId !== undefined ? { route_id: req.routeId } : {}),
      ...(req.campaignId !== undefined ? { campaign_id: req.campaignId } : {}),
      ...(req.test ? { test: true } : {}),
    });

    if (recipients.length === 1) {
      const input = recipients[0];
      const dest = normalizeDestination(input);
      if (!dest) throw new AppError('INVALID_DESTINATION', `Invalid destination number: ${input}`, { to: input });
      const r = await this.unknownOutcome(req, () => this.engine.submit(base(dest, 0)));
      return { messages: [okRow(dest, r)] };
    }

    const rows: (SendResultRow | null)[] = recipients.map(() => null);
    const pending: { index: number; dest: string }[] = [];
    recipients.forEach((input, index) => {
      const dest = normalizeDestination(input);
      if (!dest) rows[index] = { to: input, error_code: 'INVALID_DESTINATION', message: `Invalid destination number: ${input}` };
      else pending.push({ index, dest });
    });

    for (let i = 0; i < pending.length; i += ENGINE_BATCH_MAX) {
      const chunk = pending.slice(i, i + ENGINE_BATCH_MAX);
      const results = await this.unknownOutcome(req, () => this.engine.submitBatch(chunk.map((p) => base(p.dest, p.index))));
      chunk.forEach((p, j) => {
        rows[p.index] = toRow(p.dest, results[j]);
      });
    }
    return { messages: rows as SendResultRow[] };
  }

  /**
   * Message ids for an idempotent request (one per recipient, input order), remembered in Redis
   * under the org + key: the first request stores fresh UUIDv7s, a retry gets the same ones.
   */
  private async messageIds(req: SendRequest, recipients: string[]): Promise<string[] | null> {
    if (!req.idempotencyKey) return null;
    const fingerprint = sha256Hex(JSON.stringify([req.channel, recipients, req.from, req.text, req.clientRef ?? null, req.routeId ?? null]));
    const key = `idem:send:${req.orgId}:${sha256Hex(req.idempotencyKey)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const fresh = { fp: fingerprint, ids: recipients.map(() => newUuidV7()) };
      const set = await this.redis.client.set(key, JSON.stringify(fresh), 'EX', IDEMPOTENCY_TTL_SECONDS, 'NX');
      if (set === 'OK') return fresh.ids;
      const raw = await this.redis.client.get(key);
      if (raw === null) continue; // expired in between: claim it again
      const prev = JSON.parse(raw) as { fp: string; ids: string[] };
      if (prev.fp !== fingerprint || prev.ids.length !== recipients.length) {
        throw AppError.conflict('This Idempotency-Key was already used for a different request', { field: 'Idempotency-Key' });
      }
      return prev.ids;
    }
    throw AppError.internal('Could not reserve the Idempotency-Key; retry the request');
  }

  /**
   * An engine timeout / 5xx does NOT mean nothing was sent: items processed before the api gave
   * up are charged and queued. Say so, and whether repeating the request is safe.
   */
  private async unknownOutcome<T>(req: SendRequest, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (e) {
      if (!(e instanceof EngineUnavailableError)) throw e;
      throw new AppError(
        'INTERNAL',
        req.idempotencyKey
          ? 'The engine did not answer in time; some messages may have been accepted. Repeat the request with the same Idempotency-Key to get the result without sending twice.'
          : 'The engine did not answer in time; some messages may have been accepted and charged. Check GET /v1/sms/:id or the message log before retrying, or send an Idempotency-Key header to make retries safe.',
        { outcome: 'unknown', retry_safe: Boolean(req.idempotencyKey) },
        502,
      );
    }
  }
}

/** Maps one /submit/batch result; a missing/garbled entry is reported as INTERNAL for that row. */
export function toRow(to: string, r: EngineBatchResult | undefined): SendResultRow {
  if (r && isSubmitOk(r)) return okRow(to, r);
  const code = r && isErrorCode((r as { error_code?: unknown }).error_code) ? (r as { error_code: string }).error_code : 'INTERNAL';
  const message = r && typeof (r as { message?: unknown }).message === 'string' ? (r as { message: string }).message : 'Engine returned no result for this recipient';
  return { to, error_code: code, message };
}
