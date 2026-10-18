import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/errors';
import { CryptoService } from '../crypto/crypto.service';
import { connectionDto } from '../connections/connections.service';
import { DbService } from '../db/db.service';
import type { BindType, MultipartMode, TemplateFallback, UpstreamConnection } from '../db/types';
import { EngineClient } from '../engine/engine-client.service';
import type { EngineConnectionStatus } from '../engine/engine.types';
import { InvalidationService } from '../redis/redis.module';

export interface QuickExistingConnection {
  existing_connection_id: string;
  priority?: number;
  weight?: number;
}

export interface QuickSmppConnection {
  type: 'SMPP';
  name?: string;
  host: string;
  port: number;
  system_id: string;
  password: string;
  system_type?: string;
  bind_type: BindType;
  use_tls: boolean;
  max_tps: number;
  sessions: number;
  window_size?: number;
  enquire_link_interval_s?: number;
  multipart_mode?: MultipartMode;
  request_dlr: boolean;
  priority?: number;
  weight: number;
  cost_micros?: number;
}

export type QuickConnectionInput = QuickExistingConnection | QuickSmppConnection;

export interface QuickRouteInput {
  name: string;
  description?: string | null;
  enabled: boolean;
  template_mode: boolean;
  template_fallback?: TemplateFallback;
  force_sender_id?: string | null;
  template_body?: string;
  default_body?: string | null;
  connections: QuickConnectionInput[];
}

/** Live state of one route connection (GET /api/routes/:id/status). UNKNOWN = engine unreachable or not loaded yet. */
export type RouteConnectionState = 'BOUND' | 'CONNECTING' | 'DOWN' | 'DISABLED' | 'UNKNOWN';

const isExisting = (c: QuickConnectionInput): c is QuickExistingConnection => 'existing_connection_id' in c;

interface PgUniqueError {
  code: string;
  constraint?: string;
}
const isUniqueViolation = (e: unknown): e is PgUniqueError =>
  typeof e === 'object' && e !== null && (e as PgUniqueError).code === '23505';

/**
 * One-step route creation: new SMPP upstream connections (+ optional default rate), the route,
 * its connection mapping and an optional route-wide template, all in the request transaction
 * (TenantInterceptor), so any failure leaves nothing behind.
 */
@Injectable()
export class QuickRouteService {
  constructor(
    private readonly db: DbService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly invalidation: InvalidationService,
    private readonly engine: EngineClient,
  ) {}

  async create(input: QuickRouteInput) {
    validateQuick(input);
    return this.db.tenant(async (trx) => {
      const existingIds = input.connections.filter(isExisting).map((c) => c.existing_connection_id);
      const existing = existingIds.length
        ? await trx.selectFrom('upstream_connections').selectAll().where('id', 'in', existingIds).execute()
        : [];
      const missing = existingIds.filter((id) => !existing.some((c) => c.id === id));
      if (missing.length) throw AppError.invalid('Unknown existing_connection_id', { connection_ids: missing });

      // Clear message for the common case; the unique index still decides under concurrency.
      const taken = await trx.selectFrom('routes').select('id').where('name', '=', input.name).executeTakeFirst();
      if (taken) throw AppError.conflict(`A route named “${input.name}” already exists`, { field: 'name' });

      // Everything below runs in the request transaction: any failure (e.g. a later row's
      // unique conflict, or a concurrent route with the same name) rolls back every insert.
      const links: { conn: UpstreamConnection; created: boolean; priority: number; weight: number }[] = [];
      for (const [i, c] of input.connections.entries()) {
        const n = i + 1;
        if (isExisting(c)) {
          const conn = existing.find((e) => e.id === c.existing_connection_id) as UpstreamConnection;
          links.push({ conn, created: false, priority: c.priority ?? 1, weight: c.weight ?? 100 });
          continue;
        }
        const name = c.name ?? `${input.name} SMPP ${n}`;
        const conn = await trx
          .insertInto('upstream_connections')
          .values({
            name,
            host: c.host,
            port: c.port,
            use_tls: c.use_tls,
            system_id: c.system_id,
            password_enc: this.crypto.encrypt(c.password),
            ...(c.system_type !== undefined ? { system_type: c.system_type } : {}),
            bind_type: c.bind_type,
            sessions: c.sessions,
            max_tps: c.max_tps,
            ...(c.window_size !== undefined ? { window_size: c.window_size } : {}),
            ...(c.enquire_link_interval_s !== undefined ? { enquire_link_interval_s: c.enquire_link_interval_s } : {}),
            ...(c.multipart_mode !== undefined ? { multipart_mode: c.multipart_mode } : {}),
            request_dlr: c.request_dlr,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
          .catch((e: unknown) => {
            throw mapConnectionConflict(e, i, name, c);
          });
        await this.audit.record({ action: 'connection.create', entityType: 'upstream_connection', entityId: conn.id, after: connectionDto(conn) });
        await this.invalidation.invalidate('upstream_connections', conn.id);
        if (c.cost_micros !== undefined) {
          await trx.insertInto('upstream_rates').values({ connection_id: conn.id, prefix: '', cost_micros: c.cost_micros }).execute();
          await this.audit.record({
            action: 'connection.rates_replace',
            entityType: 'upstream_connection',
            entityId: conn.id,
            before: [],
            after: [{ prefix: '', cost_micros: c.cost_micros }],
          });
          await this.invalidation.invalidate('upstream_rates', null);
        }
        links.push({ conn, created: true, priority: c.priority ?? n, weight: c.weight });
      }

      const route = await trx
        .insertInto('routes')
        .values({
          name: input.name,
          description: input.description ?? null,
          enabled: input.enabled,
          template_mode: input.template_mode,
          ...(input.template_fallback !== undefined ? { template_fallback: input.template_fallback } : {}),
          force_sender_id: input.force_sender_id ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
        .catch((e: unknown) => {
          if (isUniqueViolation(e)) throw AppError.conflict(`A route named “${input.name}” already exists`, { field: 'name', constraint: e.constraint });
          throw e;
        });
      await this.audit.record({ action: 'route.create', entityType: 'route', entityId: route.id, after: route });
      await this.invalidation.invalidate('routes', route.id);

      await trx
        .insertInto('route_connections')
        .values(links.map((l) => ({ route_id: route.id, connection_id: l.conn.id, priority: l.priority, weight: l.weight, enabled: true })))
        .execute();
      const mapping = links.map((l) => ({ connection_id: l.conn.id, connection_name: l.conn.name, priority: l.priority, weight: l.weight, enabled: true }));
      await this.audit.record({ action: 'route.connections_replace', entityType: 'route', entityId: route.id, before: [], after: mapping });
      await this.invalidation.invalidate('route_connections', null);

      let template = null;
      if (input.template_body !== undefined) {
        template = await trx
          .insertInto('route_templates')
          .values({ route_id: route.id, org_id: null, name: `${input.name} default`, template_body: input.template_body, default_body: input.default_body ?? null })
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.audit.record({ action: 'template.create', entityType: 'route_template', entityId: template.id, after: template });
        await this.invalidation.invalidate('route_templates', template.id);
      }

      return {
        ...route,
        template,
        connections: links.map((l) => ({
          connection_id: l.conn.id,
          connection_name: l.conn.name,
          connection_enabled: l.conn.enabled,
          priority: l.priority,
          weight: l.weight,
          enabled: true,
          created: l.created,
          connection: connectionDto(l.conn),
        })),
      };
    });
  }

  /** Each linked connection's live engine state (CONTRACTS §5 connections/status), for one route. */
  async status(routeId: string) {
    const rows = await this.db.tenant(async (trx) => {
      const route = await trx.selectFrom('routes').select(['id', 'name', 'enabled']).where('id', '=', routeId).executeTakeFirst();
      if (!route) throw AppError.notFound('Route');
      const conns = await trx
        .selectFrom('route_connections as rc')
        .innerJoin('upstream_connections as c', 'c.id', 'rc.connection_id')
        .select([
          'rc.connection_id',
          'c.name as connection_name',
          'c.enabled as connection_enabled',
          'c.host',
          'c.port',
          'c.use_tls',
          'c.system_id',
          'c.bind_type',
          'rc.priority',
          'rc.weight',
          'rc.enabled',
        ])
        .where('rc.route_id', '=', routeId)
        .orderBy('rc.priority')
        .orderBy('c.name')
        .execute();
      return { route, conns };
    });

    let live: EngineConnectionStatus[] = [];
    let engineError: string | null = null;
    try {
      live = await this.engine.connectionsStatus();
    } catch (e) {
      engineError = (e as Error).message;
    }
    return {
      route_id: rows.route.id,
      route_enabled: rows.route.enabled,
      engine_reachable: engineError === null,
      engine_error: engineError,
      checked_at: new Date().toISOString(),
      connections: rows.conns.map((c) => ({ ...c, ...liveState(live.find((l) => l.connection_id === c.connection_id), c.connection_enabled) })),
    };
  }
}

/** Merges one engine status entry into the fields the route status card shows. */
export function liveState(s: EngineConnectionStatus | undefined, enabled: boolean) {
  if (!s) {
    return {
      state: (enabled ? 'UNKNOWN' : 'DISABLED') as RouteConnectionState,
      sessions: [] as EngineConnectionStatus['sessions'],
      sessions_bound: 0,
      sessions_total: 0,
      bound_since: null as string | null,
      last_error: null as string | null,
      tps_limit: null as number | null,
      tps_current: null as number | null,
      inflight: null as number | null,
      queue_depth: null as number | null,
    };
  }
  const sessions = s.sessions ?? [];
  const bound = sessions.filter((x) => x.bound_since !== null);
  const since = bound.map((x) => x.bound_since as string).sort()[0] ?? null;
  // Prefer an error of a session that is not bound (that's why it is down); else any.
  const err = sessions.find((x) => x.bound_since === null && x.last_error)?.last_error ?? sessions.find((x) => x.last_error)?.last_error ?? null;
  return {
    state: s.state as RouteConnectionState,
    sessions,
    sessions_bound: bound.length,
    sessions_total: sessions.length,
    bound_since: since,
    last_error: err,
    tps_limit: s.tps_limit,
    tps_current: s.tps_current,
    inflight: s.inflight,
    queue_depth: s.queue_depth,
  };
}

function validateQuick(input: QuickRouteInput): void {
  if (input.template_mode && input.template_body === undefined) {
    throw AppError.invalid('template_body is required when template_mode is on', { field: 'template_body' });
  }
  if (!input.template_mode && (input.template_body !== undefined || input.default_body != null)) {
    throw AppError.invalid('template_body / default_body need template_mode: true', { field: 'template_body' });
  }
  if (input.template_body !== undefined && !input.template_body.includes('{otp}')) {
    throw AppError.invalid('template_body must contain {otp}', { field: 'template_body' });
  }
  if (input.template_mode && input.template_fallback === 'SEND_DEFAULT_TEMPLATE' && !input.default_body) {
    throw AppError.invalid('default_body is required when template_fallback is SEND_DEFAULT_TEMPLATE', { field: 'default_body' });
  }
  const ids = input.connections.filter(isExisting).map((c) => c.existing_connection_id);
  if (new Set(ids).size !== ids.length) throw AppError.invalid('The same existing connection is listed twice', { field: 'connections' });
  const names = input.connections.filter((c): c is QuickSmppConnection => !isExisting(c) && c.name !== undefined).map((c) => c.name as string);
  if (new Set(names).size !== names.length) throw AppError.invalid('Two new connections have the same name', { field: 'connections' });
  const endpoints = input.connections
    .filter((c): c is QuickSmppConnection => !isExisting(c))
    .map((c) => `${c.host.toLowerCase()}|${c.port}|${c.system_id}`);
  if (new Set(endpoints).size !== endpoints.length) {
    throw AppError.invalid('Two new connections use the same host, port and username', { field: 'connections' });
  }
}

function mapConnectionConflict(e: unknown, index: number, name: string, c: QuickSmppConnection): unknown {
  if (!isUniqueViolation(e)) return e;
  if (e.constraint === 'upstream_connections_name_key') {
    return AppError.conflict(`A connection named “${name}” already exists`, { field: `connections.${index}.name`, constraint: e.constraint });
  }
  return AppError.conflict(
    `A connection to ${c.host}:${c.port} with username “${c.system_id}” already exists; pick it as an existing connection instead`,
    { field: `connections.${index}.host`, constraint: e.constraint },
  );
}
