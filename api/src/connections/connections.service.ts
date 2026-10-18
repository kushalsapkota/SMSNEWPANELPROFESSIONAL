import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/errors';
import { Pagination, offsetOf, page } from '../common/pagination';
import { likeContains } from '../common/validation';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
import { CryptoService } from '../crypto/crypto.service';
import { DbService } from '../db/db.service';
import type { BindType, ConnectionKind, MultipartMode, UpstreamConnection } from '../db/types';
import { EngineClient } from '../engine/engine-client.service';
import type { EngineAdapter } from '../engine/engine.types';
import { InvalidationService } from '../redis/redis.module';
import {
  AdapterCatalogue,
  DLR_CALLBACK_PATH,
  FieldIssue,
  generateDlrToken,
  mergeCredentials,
  mergeSettings,
  throwIfIssues,
} from './http-adapters';

export interface ConnectionInput {
  kind?: 'SMPP';
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

/** HTTP upstream connection (docs/providers/HTTP-CONNECTIONS-CONTRACT.md). */
export interface HttpConnectionInput {
  kind: 'HTTP';
  name: string;
  adapter: string;
  credentials?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  max_tps?: number;
  enabled?: boolean;
  notes?: string | null;
}

export type ConnectionPatch = Partial<Omit<ConnectionInput, 'kind'>> & {
  kind?: ConnectionKind;
  adapter?: string;
  credentials?: Record<string, unknown>;
  settings?: Record<string, unknown>;
};

/** Default max_tps for HTTP connections when the admin gives none. */
export const HTTP_DEFAULT_MAX_TPS = 10;

/** Columns only an SMPP connection uses; rejected on HTTP rows. */
const SMPP_ONLY_FIELDS = [
  'host',
  'port',
  'use_tls',
  'system_id',
  'password',
  'system_type',
  'bind_type',
  'sessions',
  'window_size',
  'enquire_link_interval_s',
  'reconnect_min_s',
  'reconnect_max_s',
  'submit_timeout_ms',
  'request_dlr',
  'multipart_mode',
  'default_data_coding',
] as const;
const HTTP_ONLY_FIELDS = ['adapter', 'credentials', 'settings'] as const;

/** Values for the HTTP columns of an upstream_connections insert/update. */
export interface PreparedHttp {
  adapter: string;
  http_credentials_enc: string;
  http_settings: string;
}

export type ConnectionDto = ReturnType<ConnectionsService['dto']>;
@Injectable()
export class ConnectionsService {
  private readonly publicBaseUrl: string | undefined;

  constructor(
    private readonly db: DbService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly invalidation: InvalidationService,
    private readonly engine: EngineClient,
    readonly catalogue: AdapterCatalogue,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.publicBaseUrl = config.PUBLIC_API_BASE_URL;
  }

  /**
   * Response shape. Secrets (password_enc, http_credentials_enc, dlr_token) are NEVER returned:
   * `has_password` (SMPP) / `credentials_set` (HTTP, key names only) say what is stored.
   * `dlr_callback_url` is `${PUBLIC_API_BASE_URL}/v1/provider-dlr/<dlr_token>` (null when the base
   * URL is not configured; `dlr_callback_path` is always set for HTTP rows).
   */
  dto(c: UpstreamConnection) {
    const { password_enc, http_credentials_enc, http_settings, dlr_token, ...rest } = c;
    return {
      ...rest,
      has_password: !!password_enc && password_enc.length > 0,
      credentials_set: c.kind === 'HTTP' ? Object.keys(this.credentialsOf(http_credentials_enc)).sort() : [],
      settings: (http_settings ?? {}) as Record<string, unknown>,
      ...this.callbackOf(c.kind, dlr_token),
    };
  }

  /** `{dlr_callback_path, dlr_callback_url}` for an HTTP connection's token (both null for SMPP). */
  callbackOf(kind: ConnectionKind, dlrToken: string | null): { dlr_callback_path: string | null; dlr_callback_url: string | null } {
    const path = kind === 'HTTP' && dlrToken ? `${DLR_CALLBACK_PATH}${dlrToken}` : null;
    return { dlr_callback_path: path, dlr_callback_url: path && this.publicBaseUrl ? `${this.publicBaseUrl}${path}` : null };
  }

  /** Decrypted credential map (never leaves the api except to the engine via its own decrypt). */
  private credentialsOf(enc: string | null): Record<string, string> {
    if (!enc) return {};
    try {
      const v = JSON.parse(this.crypto.decrypt(enc)) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  /**
   * Validates an HTTP connection's adapter/credentials/settings against the engine catalogue
   * and returns the column values. `existing` = the stored row on PATCH (merge semantics).
   * Throws 400 with details.issues (paths prefixed by `pathPrefix`) or 502 if the engine is down.
   */
  async prepareHttp(
    input: { adapter: string; credentials?: Record<string, unknown>; settings?: Record<string, unknown> },
    existing: UpstreamConnection | null = null,
    pathPrefix = '',
  ): Promise<PreparedHttp & { adapterSpec: EngineAdapter; credentialKeys: string[] }> {
    const adapter = await this.catalogue.require(input.adapter, `${pathPrefix}adapter`);
    const creds = mergeCredentials(adapter, input.credentials, existing ? this.credentialsOf(existing.http_credentials_enc) : {}, `${pathPrefix}credentials`);
    const settings = mergeSettings(
      adapter,
      input.settings,
      existing ? ((existing.http_settings ?? {}) as Record<string, unknown>) : {},
      `${pathPrefix}settings`,
    );
    const issues: FieldIssue[] = [...creds.issues, ...settings.issues];
    throwIfIssues(issues, issues.length === 1 ? issues[0].message : 'Request validation failed');
    return {
      adapter: adapter.id,
      http_credentials_enc: this.crypto.encrypt(JSON.stringify(creds.merged)),
      http_settings: JSON.stringify(settings.merged),
      adapterSpec: adapter,
      credentialKeys: Object.keys(creds.merged).sort(),
    };
  }

  /** GET /api/connections/adapters: the engine catalogue (cached 60s). */
  async adapters() {
    try {
      return { adapters: await this.catalogue.list() };
    } catch {
      throw new AppError('INTERNAL', 'The engine adapter catalogue is unavailable. Check that the engine is running and try again.', { reason: 'ENGINE_UNAVAILABLE' }, 502);
    }
  }

  list(q: Pagination & { q?: string; enabled?: boolean; kind?: ConnectionKind }) {
    return this.db.tenant(async (trx) => {
      let base = trx.selectFrom('upstream_connections');
      if (q.q) {
        const like = likeContains(q.q);
        base = base.where((eb) => eb.or([eb('name', 'ilike', like), eb('host', 'ilike', like), eb('adapter', 'ilike', like)]));
      }
      if (q.enabled !== undefined) base = base.where('enabled', '=', q.enabled);
      if (q.kind !== undefined) base = base.where('kind', '=', q.kind);
      const [{ total }] = await base.select((eb) => eb.fn.countAll<number>().as('total')).execute();
      const rows = await base.selectAll().orderBy('name').limit(q.page_size).offset(offsetOf(q)).execute();
      return page(rows.map((r) => this.dto(r)), total, q);
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
      return { ...this.dto(c), routes };
    });
  }

  async create(input: ConnectionInput | HttpConnectionInput) {
    if (input.kind === 'HTTP') return this.createHttp(input);
    const { password, kind: _kind, ...rest } = input;
    validateReconnect(rest.reconnect_min_s, rest.reconnect_max_s);
    return this.db.tenant(async (trx) => {
      const c = await trx
        .insertInto('upstream_connections')
        .values({ ...rest, kind: 'SMPP', password_enc: this.crypto.encrypt(password) })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record({ action: 'connection.create', entityType: 'upstream_connection', entityId: c.id, after: this.dto(c) });
      await this.invalidation.invalidate('upstream_connections', c.id);
      return this.dto(c);
    });
  }

  private async createHttp(input: HttpConnectionInput) {
    const prepared = await this.prepareHttp(input);
    return this.db.tenant(async (trx) => {
      const c = await trx
        .insertInto('upstream_connections')
        .values({
          kind: 'HTTP',
          name: input.name,
          adapter: prepared.adapter,
          http_credentials_enc: prepared.http_credentials_enc,
          http_settings: prepared.http_settings,
          dlr_token: generateDlrToken(),
          max_tps: input.max_tps ?? HTTP_DEFAULT_MAX_TPS,
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record({ action: 'connection.create', entityType: 'upstream_connection', entityId: c.id, after: this.dto(c) });
      await this.invalidation.invalidate('upstream_connections', c.id);
      return this.dto(c);
    });
  }

  update(id: string, input: ConnectionPatch) {
    if (Object.keys(input).length === 0) throw AppError.invalid('Nothing to update');
    return this.db.tenant(async (trx) => {
      const before = await trx.selectFrom('upstream_connections').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!before) throw AppError.notFound('Connection');
      if (input.kind !== undefined && input.kind !== before.kind) {
        throw AppError.invalid('The connection type (kind) cannot be changed; create a new connection instead', {
          issues: [{ path: 'kind', message: 'cannot be changed', code: 'custom' }],
        });
      }
      const wrong = (before.kind === 'HTTP' ? SMPP_ONLY_FIELDS : HTTP_ONLY_FIELDS).filter((f) => (input as Record<string, unknown>)[f] !== undefined);
      if (wrong.length) {
        throw AppError.invalid(`${wrong.join(', ')} ${wrong.length === 1 ? 'does' : 'do'} not apply to ${before.kind} connections`, {
          issues: wrong.map((f) => ({ path: f, message: `not allowed for ${before.kind} connections`, code: 'custom' })),
        });
      }
      const { password, kind: _kind, adapter, credentials, settings, ...rest } = input;
      let httpCols: PreparedHttp | null = null;
      if (before.kind === 'HTTP' && (adapter !== undefined || credentials !== undefined || settings !== undefined)) {
        const p = await this.prepareHttp({ adapter: adapter ?? (before.adapter as string), credentials, settings }, before);
        httpCols = { adapter: p.adapter, http_credentials_enc: p.http_credentials_enc, http_settings: p.http_settings };
      }
      if (before.kind === 'SMPP') validateReconnect(rest.reconnect_min_s ?? before.reconnect_min_s, rest.reconnect_max_s ?? before.reconnect_max_s);
      const after = await trx
        .updateTable('upstream_connections')
        .set({
          ...rest,
          ...(password !== undefined ? { password_enc: this.crypto.encrypt(password) } : {}),
          ...(httpCols ?? {}),
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record({
        action: 'connection.update',
        entityType: 'upstream_connection',
        entityId: id,
        before: this.dto(before),
        after: {
          ...this.dto(after),
          ...(password !== undefined ? { password_changed: true } : {}),
          // Key names only (set / cleared), never values.
          ...(credentials !== undefined ? { credentials_changed: Object.keys(credentials).sort() } : {}),
        },
      });
      await this.invalidation.invalidate('upstream_connections', id);
      return this.dto(after);
    });
  }

  /** Ensures the connection exists (404 otherwise) and returns its kind. */
  private async kindOf(id: string): Promise<ConnectionKind> {
    const c = await this.db.tenant((trx) => trx.selectFrom('upstream_connections').select('kind').where('id', '=', id).executeTakeFirst());
    if (!c) throw AppError.notFound('Connection');
    return c.kind;
  }

  /**
   * POST /api/connections/:id/test: ONE real message through the connection (engine, outside
   * billing/CDR). The engine masks secrets in the echoed request. Audited (destination only).
   */
  async test(id: string, body: { to: string; text: string }) {
    await this.kindOf(id);
    const r = await this.engine.testConnection(id, body);
    await this.db.tenant(() =>
      this.audit.record({
        action: 'connection.test',
        entityType: 'upstream_connection',
        entityId: id,
        after: { to: body.to, ok: r.ok, http_status: r.http_status, provider_message_id: r.provider_message_id },
      }),
    );
    return r;
  }

  /** GET /api/connections/:id/balance: provider balance through the engine. */
  async balance(id: string) {
    await this.kindOf(id);
    return this.engine.providerBalance(id);
  }

  remove(id: string) {
    return this.db.tenant(async (trx) => {
      const before = await trx.selectFrom('upstream_connections').selectAll().where('id', '=', id).executeTakeFirst();
      if (!before) throw AppError.notFound('Connection');
      await trx.deleteFrom('upstream_connections').where('id', '=', id).execute();
      await this.audit.record({ action: 'connection.delete', entityType: 'upstream_connection', entityId: id, before: this.dto(before) });
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
