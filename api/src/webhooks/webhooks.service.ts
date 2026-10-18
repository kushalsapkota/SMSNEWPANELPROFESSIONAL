import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/errors';
import { Pagination, offsetOf, page } from '../common/pagination';
import { CryptoService, hmacSha256Hex } from '../crypto/crypto.service';
import { DbService } from '../db/db.service';
import type { Webhook } from '../db/types';
import { InvalidationService } from '../redis/redis.module';
import { ScopeService } from '../tenancy/scope.service';
import { BlockedTargetError, EgressPolicy, assertWebhookTarget, postWebhook } from './egress';

export interface WebhookInput {
  url: string;
  events?: string[];
  max_retries?: number;
  enabled?: boolean;
}

/** secret_enc is never returned; the plaintext secret only from create / rotate. */
export function webhookDto(w: Webhook) {
  const { secret_enc, ...rest } = w;
  void secret_enc;
  return rest;
}

/** CONTRACTS §2 signature headers. Exported so tests / other senders share one implementation. */
export function signWebhook(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): Record<string, string> {
  return {
    'X-Webhook-Timestamp': String(timestamp),
    'X-Webhook-Signature': `sha256=${hmacSha256Hex(secret, `${timestamp}.${body}`)}`,
  };
}

@Injectable()
export class WebhooksService {
  private readonly egress: EgressPolicy;

  constructor(
    private readonly db: DbService,
    private readonly scope: ScopeService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly invalidation: InvalidationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.egress = { allowPrivate: config.WEBHOOK_ALLOW_PRIVATE_TARGETS };
  }

  async list(q: Pagination & { org_id?: string }) {
    const org = await this.scope.resolve(q.org_id, 'read');
    return this.db.tenant(async (trx) => {
      const base = trx.selectFrom('webhooks').where('org_id', '=', org.id);
      const [{ total }] = await base.select((eb) => eb.fn.countAll<number>().as('total')).execute();
      const rows = await base.selectAll().orderBy('created_at', 'desc').limit(q.page_size).offset(offsetOf(q)).execute();
      return page(rows.map(webhookDto), total, q);
    });
  }

  async create(orgIdParam: string | undefined, input: WebhookInput) {
    const org = await this.scope.resolve(orgIdParam, 'write');
    if (org.role === 'SUPER_ADMIN') throw AppError.invalid('Webhooks belong to resellers and clients');
    await assertWebhookTarget(input.url, this.egress);
    const secret = this.crypto.generateWebhookSecret();
    return this.db.tenant(async (trx) => {
      const row = await trx
        .insertInto('webhooks')
        .values({ org_id: org.id, url: input.url, events: input.events, max_retries: input.max_retries, enabled: input.enabled, secret_enc: this.crypto.encrypt(secret) })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record({ action: 'webhook.create', entityType: 'webhook', entityId: row.id, targetOrgId: org.id, after: webhookDto(row) });
      await this.invalidation.invalidate('webhooks', row.id);
      return { ...webhookDto(row), secret };
    });
  }

  async update(id: string, input: Partial<WebhookInput> & { rotate_secret?: boolean }) {
    const { rotate_secret, ...fields } = input;
    if (Object.keys(input).length === 0) throw AppError.invalid('Nothing to update');
    const secret = rotate_secret ? this.crypto.generateWebhookSecret() : null;
    return this.db.tenant(async (trx) => {
      const before = await this.load(id, 'write');
      if (fields.url !== undefined) await assertWebhookTarget(fields.url, this.egress);
      const after = await trx
        .updateTable('webhooks')
        .set({ ...fields, ...(secret ? { secret_enc: this.crypto.encrypt(secret) } : {}), ...(fields.enabled ? { failure_count: 0 } : {}) })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record({
        action: 'webhook.update',
        entityType: 'webhook',
        entityId: id,
        targetOrgId: before.org_id,
        before: webhookDto(before),
        after: { ...webhookDto(after), ...(secret ? { secret_rotated: true } : {}) },
      });
      await this.invalidation.invalidate('webhooks', id);
      return { ...webhookDto(after), ...(secret ? { secret } : {}) };
    });
  }

  async remove(id: string) {
    return this.db.tenant(async (trx) => {
      const before = await this.load(id, 'write');
      await trx.deleteFrom('webhooks').where('id', '=', id).execute();
      await this.audit.record({ action: 'webhook.delete', entityType: 'webhook', entityId: id, targetOrgId: before.org_id, before: webhookDto(before) });
      await this.invalidation.invalidate('webhooks', id);
      return { ok: true };
    });
  }

  /**
   * Sends a signed sample DLR (CONTRACTS §9 payload, plus `"test": true`) from the api and
   * logs it in webhook_deliveries. Runs without a request transaction so no DB connection is
   * held while waiting on the remote endpoint. SSRF guard: the target is re-validated and the
   * connected address must be public (egress.ts); only the status code is reported back
   * (`response_body` is always null — the api never relays what a target answered).
   */
  async test(id: string) {
    const hook = await this.db.tenant(() => this.load(id, 'write'));
    const secret = this.crypto.decrypt(hook.secret_enc);
    const now = new Date();
    const payload = {
      event: 'dlr',
      message_id: randomUUID(),
      client_ref: 'webhook-test',
      to: '919876543210',
      from: 'TEST',
      status: 'DELIVERED',
      dlr_stat: 'DELIVRD',
      dlr_err: '000',
      parts: 1,
      submitted_at: new Date(now.getTime() - 3000).toISOString(),
      done_at: now.toISOString(),
      test: true,
    };
    const body = JSON.stringify(payload);
    const started = Date.now();
    let statusCode: number | null = null;
    let error: string | null = null;
    try {
      await assertWebhookTarget(hook.url, this.egress);
      const res = await postWebhook(
        hook.url,
        { 'Content-Type': 'application/json', 'User-Agent': 'smsgw-webhook/1.0', ...signWebhook(secret, body) },
        body,
        this.config.WEBHOOK_TEST_TIMEOUT_MS,
        this.egress,
      );
      statusCode = res.status;
      if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
    } catch (e) {
      if (e instanceof AppError) error = e.message;
      else if (e instanceof BlockedTargetError) error = 'target address is not allowed (private, loopback or reserved)';
      else {
        const err = e as Error & { code?: string };
        // Coarse error classes only: no internal details for a client-chosen target.
        error = err.name === 'TimeoutError' ? `timeout after ${this.config.WEBHOOK_TEST_TIMEOUT_MS}ms` : err.code ?? 'connection failed';
      }
    }
    const durationMs = Date.now() - started;
    const delivery = await this.db.tenant((trx) =>
      trx
        .insertInto('webhook_deliveries')
        .values({ webhook_id: hook.id, org_id: hook.org_id, message_id: null, attempt: 1, status_code: statusCode, error, duration_ms: durationMs })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
    return { ok: error === null, status_code: statusCode, duration_ms: durationMs, error, response_body: null, delivery_id: delivery.id, payload };
  }

  async deliveries(id: string, q: Pagination) {
    const hook = await this.db.tenant(() => this.load(id, 'read'));
    return this.db.tenant(async (trx) => {
      const base = trx.selectFrom('webhook_deliveries').where('webhook_id', '=', hook.id);
      const [{ total }] = await base.select((eb) => eb.fn.countAll<number>().as('total')).execute();
      const rows = await base.selectAll().orderBy('created_at', 'desc').orderBy('id', 'desc').limit(q.page_size).offset(offsetOf(q)).execute();
      return page(rows, total, q);
    });
  }

  private async load(id: string, mode: 'read' | 'write'): Promise<Webhook> {
    return this.db.tenant(async (trx) => {
      const row = await trx.selectFrom('webhooks').selectAll().where('id', '=', id).executeTakeFirst();
      if (!row) throw AppError.notFound('Webhook');
      await this.scope.assertOrgAccess(row.org_id, mode);
      return row;
    });
  }
}
