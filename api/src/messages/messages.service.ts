import { Injectable } from '@nestjs/common';
import { RawBuilder, Transaction, sql } from 'kysely';
import type { Response } from 'express';
import { currentAuth } from '../common/context';
import { AppError } from '../common/errors';
import { DbService } from '../db/db.service';
import type { DB, MsgChannel, MsgStatus } from '../db/types';
import { csvField, csvRow } from '../messaging/csv';
import { microsToDecimal } from '../messaging/money';
import { normalizeDestination } from '../messaging/msisdn';
import { OrgFilter, actingOrgFilter, allOf, orgFilterConds, resolveOrgFilter } from '../messaging/org-filter';
import { uuidV7Window } from '../messaging/uuidv7';
import { ScopeService, isUuid } from '../tenancy/scope.service';
import { MessageRow, messageDto } from './message.dto';

export interface MessageFilters {
  from: Date;
  to: Date;
  status?: MsgStatus[];
  destination?: string;
  source?: string;
  route_id?: string;
  channel?: MsgChannel;
  campaign_id?: string;
  q?: string;
}

export interface Cursor {
  createdAt: string;
  id: string;
}

export const EXPORT_MAX_ROWS = 1_000_000;
const EXPORT_BATCH = 5000;

/** Postgres timestamptz text (round-trips exactly, µs precision) as produced by `created_at::text`. */
const PG_TS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2}){0,2}|Z)?$/;

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.createdAt, c.id]), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && PG_TS.test(v[0]) && isUuid(v[1])) {
      return { createdAt: v[0], id: v[1] };
    }
  } catch {
    // fall through
  }
  throw AppError.invalid('cursor is malformed', { field: 'cursor' });
}

@Injectable()
export class MessagesService {
  constructor(
    private readonly db: DbService,
    private readonly scope: ScopeService,
  ) {}

  async list(orgIdParam: string | undefined, f: MessageFilters, limit: number, cursor?: string) {
    const auth = currentAuth();
    const orgFilter = await resolveOrgFilter(this.scope, orgIdParam);
    const c = cursor ? decodeCursor(cursor) : undefined;
    const rows = await this.db.tenant((trx) => this.fetch(trx, orgFilter, f, limit + 1, c));
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return {
      items: items.map((m) => messageDto(m, auth.role)),
      next_cursor: hasMore && last ? encodeCursor({ createdAt: last.created_at_text, id: last.id }) : null,
    };
  }

  /** One CDR the caller may see (admin: any; reseller: own + clients'; client: own). */
  async get(id: string) {
    const auth = currentAuth();
    const row = await this.findVisible(id);
    if (!row) throw AppError.notFound('Message');
    return messageDto(row, auth.role);
  }

  async findVisible(id: string): Promise<MessageRow | undefined> {
    const conds = [sql<boolean>`m.id = ${id}::uuid`, ...orgFilterConds(actingOrgFilter(), 'm')];
    const win = uuidV7Window(id);
    if (win) conds.push(sql<boolean>`m.created_at >= ${win.from}`, sql<boolean>`m.created_at < ${win.to}`);
    return this.db.tenant((trx) => this.baseQuery(trx).where(allOf(conds)).executeTakeFirst());
  }

  /**
   * Streams the filtered CDRs as CSV (keyset batches of 5000, each in its own short tenant
   * transaction, so no long-running snapshot or open cursor). Max 1,000,000 rows; money
   * as decimal currency units. Backpressure-aware; stops when the client disconnects.
   */
  async exportCsv(orgIdParam: string | undefined, f: MessageFilters, res: Response): Promise<void> {
    const auth = currentAuth();
    const orgFilter = await resolveOrgFilter(this.scope, orgIdParam);
    const admin = auth.role === 'SUPER_ADMIN';
    const reseller = auth.role === 'RESELLER';
    const columns: [string, (m: MessageRow) => string][] = [
      ['message_id', (m) => m.id],
      ['created_at', (m) => csvField(m.created_at)],
      ['org_id', (m) => m.org_id],
      ['org_name', (m) => csvField(m.org_name, true)],
      ['channel', (m) => m.channel],
      ['client_ref', (m) => csvField(m.client_msg_ref, true)],
      ['source', (m) => csvField(m.source_addr, true)],
      ['destination', (m) => csvField(m.destination_addr)],
      ['country', (m) => csvField(m.country_iso)],
      ['route', (m) => csvField(m.route_name, true)],
      ['status', (m) => m.status],
      ['error_code', (m) => csvField(m.error_code)],
      ['dlr_stat', (m) => csvField(m.dlr_stat)],
      ['dlr_err', (m) => csvField(m.dlr_err)],
      ['parts', (m) => String(m.parts)],
      ['encoding', (m) => m.encoding],
      ['text', (m) => csvField(m.orig_text, true)],
      ['sent_text', (m) => csvField(m.sent_text, true)],
      ['cost', (m) => microsToDecimal(m.client_cost_micros)],
      ...(admin || reseller ? ([['reseller_cost', (m: MessageRow) => microsToDecimal(m.reseller_cost_micros)]] as [string, (m: MessageRow) => string][]) : []),
      ...(admin ? ([['route_cost', (m: MessageRow) => microsToDecimal(m.route_cost_micros)]] as [string, (m: MessageRow) => string][]) : []),
      ['refunded', (m) => (m.refunded ? 'true' : 'false')],
      ['submitted_at', (m) => csvField(m.submitted_at)],
      ['dlr_received_at', (m) => csvField(m.dlr_received_at)],
      ['campaign_id', (m) => csvField(m.campaign_id)],
    ];

    // Validate the first batch before committing to a 200 response, so errors still render as JSON.
    let batch = await this.db.tenant((trx) => this.fetch(trx, orgFilter, f, EXPORT_BATCH));
    const stamp = (d: Date) => d.toISOString().slice(0, 10);
    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="messages-${stamp(f.from)}-${stamp(f.to)}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Export-Max-Rows', String(EXPORT_MAX_ROWS));

    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    const write = async (chunk: string): Promise<void> => {
      if (!res.write(chunk)) await new Promise<void>((resolve) => {
        const done = () => {
          res.off('drain', done);
          res.off('close', done);
          resolve();
        };
        res.on('drain', done);
        res.on('close', done);
      });
    };

    await write('﻿' + csvRow(columns.map(([h]) => h)));
    let written = 0;
    try {
      while (batch.length > 0 && !closed) {
        const take = Math.min(batch.length, EXPORT_MAX_ROWS - written);
        let out = '';
        for (let i = 0; i < take; i++) out += csvRow(columns.map(([, fn]) => fn(batch[i])));
        await write(out);
        written += take;
        if (written >= EXPORT_MAX_ROWS || batch.length < EXPORT_BATCH) break;
        const last = batch[batch.length - 1];
        batch = await this.db.tenant((trx) => this.fetch(trx, orgFilter, f, EXPORT_BATCH, { createdAt: last.created_at_text, id: last.id }));
      }
    } catch (e) {
      // Headers are gone; the only honest signal left is an aborted (truncated) response.
      res.destroy(e as Error);
      return;
    }
    res.end();
  }

  private baseQuery(trx: Transaction<DB>) {
    return trx
      .selectFrom('message_logs as m')
      .leftJoin('organizations as o', 'o.id', 'm.org_id')
      .leftJoin('routes as r', 'r.id', 'm.route_id')
      .leftJoin('upstream_connections as uc', 'uc.id', 'm.connection_id') // admin-only under RLS; null otherwise
      .selectAll('m')
      .select([
        sql<string>`m.created_at::text`.as('created_at_text'),
        'o.name as org_name',
        'r.name as route_name',
        'uc.name as connection_name',
      ]);
  }

  private fetch(trx: Transaction<DB>, orgFilter: OrgFilter, f: MessageFilters, limit: number, cursor?: Cursor): Promise<MessageRow[]> {
    const conds = [...orgFilterConds(orgFilter, 'm'), ...filterConds(f)];
    if (cursor) conds.push(sql<boolean>`(m.created_at, m.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`);
    return this.baseQuery(trx)
      .where(allOf(conds))
      .orderBy('m.created_at', 'desc')
      .orderBy('m.id', 'desc')
      .limit(limit)
      .execute() as Promise<MessageRow[]>;
  }
}

/** Always bounded by created_at (partition pruning); every other filter is optional. */
export function filterConds(f: MessageFilters): RawBuilder<boolean>[] {
  const c: RawBuilder<boolean>[] = [sql<boolean>`m.created_at >= ${f.from}`, sql<boolean>`m.created_at < ${f.to}`];
  if (f.status && f.status.length > 0) c.push(sql<boolean>`m.status = any(${f.status}::msg_status[])`);
  if (f.channel) c.push(sql<boolean>`m.channel = ${f.channel}::msg_channel`);
  if (f.route_id) c.push(sql<boolean>`m.route_id = ${f.route_id}::uuid`);
  if (f.campaign_id) c.push(sql<boolean>`m.campaign_id = ${f.campaign_id}::uuid`);
  if (f.destination) {
    const full = normalizeDestination(f.destination);
    if (full) c.push(sql<boolean>`m.destination_addr = ${full}`);
    else {
      const digits = f.destination.replace(/[\s\-+().]/g, '');
      if (!/^[0-9]{1,15}$/.test(digits)) throw AppError.invalid('destination must be digits (full number or prefix)', { field: 'destination' });
      c.push(sql<boolean>`m.destination_addr like ${digits + '%'}`);
    }
  }
  if (f.source) {
    const s = f.source.trim();
    const numeric = /^\+?[0-9]+$/.test(s);
    c.push(numeric ? sql<boolean>`ltrim(m.source_addr, '+') = ${s.replace(/^\+/, '')}` : sql<boolean>`lower(m.source_addr) = lower(${s})`);
  }
  if (f.q) {
    const q = f.q.trim();
    const like = `%${q.replace(/[\\%_]/g, (ch) => '\\' + ch)}%`;
    c.push(
      isUuid(q)
        ? sql<boolean>`(m.id = ${q.toLowerCase()}::uuid or m.client_msg_ref = ${q})`
        : sql<boolean>`(m.client_msg_ref = ${q} or m.orig_text ilike ${like} or m.sent_text ilike ${like})`,
    );
  }
  return c;
}
