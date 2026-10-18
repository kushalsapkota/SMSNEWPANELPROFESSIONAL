import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/errors';
import { Pagination, offsetOf, page } from '../common/pagination';
import { likeContains } from '../common/validation';
import { CryptoService } from '../crypto/crypto.service';
import { DbService } from '../db/db.service';
import type { BindType, MultipartMode, UpstreamConnection } from '../db/types';
import { InvalidationService } from '../redis/redis.module';

export interface ConnectionInput {
  name: string;
  host: string;
  port: number;
  use_tls?: boolean;
  system_id: string;
  password: string;
  system_type?: string;
  bind_type?: BindType;
  sessions?: number;
  max_tps: number;
  window_size?: number;
  enquire_link_interval_s?: number;
  reconnect_min_s?: number;
  reconnect_max_s?: number;
  submit_timeout_ms?: number;
  request_dlr?: boolean;
  multipart_mode?: MultipartMode;
  default_data_coding?: number;
  enabled?: boolean;
  notes?: string | null;
}

/** password_enc is NEVER returned (write-only). */
export function connectionDto(c: UpstreamConnection) {
  const { password_enc, ...rest } = c;
  return { ...rest, has_password: password_enc.length > 0 };
}

@Injectable()
export class ConnectionsService {
  constructor(
    private readonly db: DbService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly invalidation: InvalidationService,
  ) {}

  list(q: Pagination & { q?: string; enabled?: boolean }) {
    return this.db.tenant(async (trx) => {
      let base = trx.selectFrom('upstream_connections');
      if (q.q) base = base.where((eb) => eb.or([eb('name', 'ilike', likeContains(q.q as string)), eb('host', 'ilike', likeContains(q.q as string))]));
      if (q.enabled !== undefined) base = base.where('enabled', '=', q.enabled);
      const [{ total }] = await base.select((eb) => eb.fn.countAll<number>().as('total')).execute();
      const rows = await base.selectAll().orderBy('name').limit(q.page_size).offset(offsetOf(q)).execute();
      return page(rows.map(connectionDto), total, q);
    });
  }

  async get(id: string) {
    return this.db.tenant(async (trx) => {
      const c = await trx.selectFrom('upstream_connections').selectAll().where('id', '=', id).executeTakeFirst();
      if (!c) throw AppError.notFound('Connection');
      const routes = await trx
        .selectFrom('route_connections as rc')
        .innerJoin('routes as r', 'r.id', 'rc.route_id')
        .select(['r.id as route_id', 'r.name as route_name', 'rc.priority', 'rc.weight', 'rc.enabled'])
        .where('rc.connection_id', '=', id)
        .orderBy('r.name')
        .execute();
      return { ...connectionDto(c), routes };
    });
  }

  create(input: ConnectionInput) {
    const { password, ...rest } = input;
    validateReconnect(rest.reconnect_min_s, rest.reconnect_max_s);
    return this.db.tenant(async (trx) => {
      const c = await trx
        .insertInto('upstream_connections')
        .values({ ...rest, password_enc: this.crypto.encrypt(password) })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record({ action: 'connection.create', entityType: 'upstream_connection', entityId: c.id, after: connectionDto(c) });
      await this.invalidation.invalidate('upstream_connections', c.id);
      return connectionDto(c);
    });
  }

  update(id: string, input: Partial<ConnectionInput>) {
    const { password, ...rest } = input;
    if (Object.keys(input).length === 0) throw AppError.invalid('Nothing to update');
    return this.db.tenant(async (trx) => {
      const before = await trx.selectFrom('upstream_connections').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!before) throw AppError.notFound('Connection');
      validateReconnect(rest.reconnect_min_s ?? before.reconnect_min_s, rest.reconnect_max_s ?? before.reconnect_max_s);
      const after = await trx
        .updateTable('upstream_connections')
        .set({ ...rest, ...(password !== undefined ? { password_enc: this.crypto.encrypt(password) } : {}) })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record({
        action: 'connection.update',
        entityType: 'upstream_connection',
        entityId: id,
        before: connectionDto(before),
        after: { ...connectionDto(after), ...(password !== undefined ? { password_changed: true } : {}) },
      });
      await this.invalidation.invalidate('upstream_connections', id);
      return connectionDto(after);
    });
  }

  remove(id: string) {
    return this.db.tenant(async (trx) => {
      const before = await trx.selectFrom('upstream_connections').selectAll().where('id', '=', id).executeTakeFirst();
      if (!before) throw AppError.notFound('Connection');
      await trx.deleteFrom('upstream_connections').where('id', '=', id).execute();
      await this.audit.record({ action: 'connection.delete', entityType: 'upstream_connection', entityId: id, before: connectionDto(before) });
      await this.invalidation.invalidate('upstream_connections', id);
      await this.invalidation.invalidate('route_connections', null);
      await this.invalidation.invalidate('upstream_rates', null);
      return { ok: true };
    });
  }

  rates(id: string) {
    return this.db.tenant(async (trx) => {
      await this.mustExist(trx, id);
      const rows = await trx
        .selectFrom('upstream_rates')
        .select(['id', 'prefix', 'cost_micros', 'effective_from'])
        .where('connection_id', '=', id)
        .orderBy('prefix')
        .orderBy('effective_from', 'desc')
        .execute();
      return { items: rows };
    });
  }

  /** Replace the connection's rate card. */
  replaceRates(id: string, rates: { prefix: string; cost_micros: number }[]) {
    const seen = new Set<string>();
    for (const r of rates) {
      if (seen.has(r.prefix)) throw AppError.invalid(`Duplicate prefix '${r.prefix}'`, { prefix: r.prefix });
      seen.add(r.prefix);
    }
    return this.db.tenant(async (trx) => {
      await this.mustExist(trx, id);
      const before = await trx.selectFrom('upstream_rates').select(['prefix', 'cost_micros']).where('connection_id', '=', id).orderBy('prefix').execute();
      await trx.deleteFrom('upstream_rates').where('connection_id', '=', id).execute();
      if (rates.length) {
        await trx
          .insertInto('upstream_rates')
          .values(rates.map((r) => ({ connection_id: id, prefix: r.prefix, cost_micros: r.cost_micros })))
          .execute();
      }
      await this.audit.record({ action: 'connection.rates_replace', entityType: 'upstream_connection', entityId: id, before, after: rates });
      await this.invalidation.invalidate('upstream_rates', null);
      return this.rates(id);
    });
  }

  private async mustExist(trx: Parameters<Parameters<DbService['tenant']>[0]>[0], id: string): Promise<void> {
    const c = await trx.selectFrom('upstream_connections').select('id').where('id', '=', id).executeTakeFirst();
    if (!c) throw AppError.notFound('Connection');
  }
}

function validateReconnect(min?: number, max?: number): void {
  if (min !== undefined && max !== undefined && max < min) {
    throw AppError.invalid('reconnect_max_s must be >= reconnect_min_s', { field: 'reconnect_max_s' });
  }
}
