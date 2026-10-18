import { Injectable } from '@nestjs/common';
import { AppError, isErrorCode } from '../common/errors';
import { EngineClient } from '../engine/engine-client.service';
import type { EngineBatchResult, EngineSubmitOk, EngineSubmitRequest } from '../engine/engine.types';
import { normalizeDestination, splitRecipients } from './msisdn';

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
  constructor(private readonly engine: EngineClient) {}

  async send(req: SendRequest): Promise<{ messages: SendResultRow[] }> {
    const recipients = splitRecipients(req.to);
    if (recipients.length === 0) throw AppError.invalid('At least one recipient is required', { field: 'to' });
    if (recipients.length > MAX_RECIPIENTS) {
      throw AppError.invalid(`At most ${MAX_RECIPIENTS} recipients per request`, { field: 'to', count: recipients.length });
    }

    const base = (destination: string): EngineSubmitRequest => ({
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
      const r = await this.engine.submit(base(dest));
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
      const results = await this.engine.submitBatch(chunk.map((p) => base(p.dest)));
      chunk.forEach((p, j) => {
        rows[p.index] = toRow(p.dest, results[j]);
      });
    }
    return { messages: rows as SendResultRow[] };
  }
}

/** Maps one /submit/batch result; a missing/garbled entry is reported as INTERNAL for that row. */
export function toRow(to: string, r: EngineBatchResult | undefined): SendResultRow {
  if (r && isSubmitOk(r)) return okRow(to, r);
  const code = r && isErrorCode((r as { error_code?: unknown }).error_code) ? (r as { error_code: string }).error_code : 'INTERNAL';
  const message = r && typeof (r as { message?: unknown }).message === 'string' ? (r as { message: string }).message : 'Engine returned no result for this recipient';
  return { to, error_code: code, message };
}
