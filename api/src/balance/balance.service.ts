import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Kysely, Transaction, sql } from 'kysely';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
import { AuditService } from '../audit/audit.service';
import { currentAuth } from '../common/context';
import { AppError } from '../common/errors';
import { Pagination, offsetOf, page } from '../common/pagination';
import { DbService } from '../db/db.service';
import type { BalanceTransaction, BillingMode, DB, LedgerType } from '../db/types';
import { EngineClient, EngineUnavailableError } from '../engine/engine-client.service';
import type { EngineCreditResponse } from '../engine/engine.types';
import { balanceDto } from '../orgs/orgs.service';
import { InvalidationService } from '../redis/redis.module';
import { ScopeService } from '../tenancy/scope.service';

export interface CreditInput {
  amount_micros: number;
  note?: string;
  reference?: string;
  idempotency_key?: string;
}

export interface BillingPatch {
  billing_mode?: BillingMode;
  credit_limit_micros?: number;
  low_balance_alert_micros?: number | null;
}

export function transactionDto(t: BalanceTransaction) {
  return {
    id: t.id,
    org_id: t.org_id,
    type: t.type,
    amount_micros: t.amount_micros,
    balance_after_micros: t.balance_after_micros,
    reference: t.reference,
    note: t.note,
    created_by_user_id: t.created_by_user_id,
    applied_at: t.applied_at,
    created_at: t.created_at,
  };
}

/** Rows older than this with applied_at NULL are retried by the reconciler. */
const RECONCILE_MIN_AGE_SECONDS = 60;

/**
 * CONTRACTS §6 balance flow:
 *   1. insert balance_transactions row (idempotency_key) and COMMIT;
 *   2. BEGIN; lock accounts_balance FOR UPDATE; POST /internal/v1/balance/credit with that key;
 *   3. OK/DUPLICATE -> set applied_at (+ balance_after); NOT_LOADED -> also add the delta to
 *      accounts_balance.balance_micros (hydration picks it up); COMMIT. Never touch the
 *      snapshot on OK.
 * If step 2 fails the row stays unapplied and the reconciler retries it with the same key.
 */
@Injectable()
export class BalanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BalanceService.name);
  private timer: NodeJS.Timeout | null = null;
  private reconciling = false;

  constructor(
    private readonly db: DbService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly engine: EngineClient,
    private readonly invalidation: InvalidationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    const every = this.config.LEDGER_RECONCILE_INTERVAL_MS;
    if (every > 0) {
      this.timer = setInterval(() => void this.reconcileOnce().catch((e) => this.logger.warn(`reconcile failed: ${(e as Error).message}`)), every);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async get(orgId: string) {
    await this.scope.getOrg(orgId, 'read');
    const row = await this.db.tenant((trx) => trx.selectFrom('accounts_balance').selectAll().where('org_id', '=', orgId).executeTakeFirst());
    if (!row) throw AppError.notFound('Balance (SUPER_ADMIN is never billed)');
    const dto = balanceDto(row);
    try {
      const live = await this.engine.getBalance(orgId);
      return { ...dto, balance_micros: live.balance_micros, credit_limit_micros: live.credit_limit_micros, source: 'engine' as const };
    } catch (e) {
      this.logger.debug?.(`live balance unavailable for ${orgId}: ${(e as Error).message}`);
      return { ...dto, source: 'database' as const, synced_at: row.synced_at };
    }
  }

  topup(orgId: string, input: CreditInput) {
    if (input.amount_micros <= 0) throw AppError.invalid('amount_micros must be > 0');
    return this.credit(orgId, 'TOPUP', input);
  }

  adjust(orgId: string, input: CreditInput) {
    if (input.amount_micros === 0) throw AppError.invalid('amount_micros must not be 0');
    if (!input.note) throw AppError.invalid('note is required for adjustments', { field: 'note' });
    return this.credit(orgId, 'ADJUSTMENT', input);
  }

  /** Must be called WITHOUT a surrounding request transaction (controller uses @NoRequestTransaction). */
  private async credit(orgId: string, type: LedgerType, input: CreditInput) {
    const auth = currentAuth();
    const idemKey = input.idempotency_key ? `${type.toLowerCase()}:${orgId}:${input.idempotency_key}` : `${type.toLowerCase()}:${randomUUID()}`;

    // Step 1: ledger row, committed before the engine is called.
    const { txn, replay } = await this.db.tenant(async (trx) => {
      await this.scope.requireChild(orgId);
      const bal = await trx.selectFrom('accounts_balance').select('org_id').where('org_id', '=', orgId).executeTakeFirst();
      if (!bal) throw AppError.notFound('Balance account');
      const inserted = await trx
        .insertInto('balance_transactions')
        .values({
          org_id: orgId,
          type,
          amount_micros: input.amount_micros,
          idempotency_key: idemKey,
          note: input.note ?? null,
          reference: input.reference ?? null,
          created_by_user_id: auth.userId,
        })
        .onConflict((oc) => oc.column('idempotency_key').doNothing())
        .returningAll()
        .executeTakeFirst();
      if (!inserted) {
        const existing = await trx.selectFrom('balance_transactions').selectAll().where('idempotency_key', '=', idemKey).executeTakeFirst();
        if (!existing) throw AppError.conflict('idempotency_key already used');
        if (existing.amount_micros !== input.amount_micros || existing.type !== type) {
          throw AppError.conflict('idempotency_key was already used with a different request');
        }
        return { txn: existing, replay: true };
      }
      await this.audit.record({
        action: type === 'TOPUP' ? 'balance.topup' : 'balance.adjust',
        entityType: 'balance_transaction',
        entityId: inserted.id,
        targetOrgId: orgId,
        after: transactionDto(inserted),
      });
      return { txn: inserted, replay: false };
    });

    if (txn.applied_at) return { transaction: transactionDto(txn), status: 'DUPLICATE' as const, replay };

    // Steps 2+3 in one transaction holding accounts_balance FOR UPDATE across the engine call
    // (CONTRACTS-CHANGES engine-core #3): engine hydration locks the same row, so a top-up can't
    // race a first-use hydration and get lost on NOT_LOADED.
    try {
      const out = await this.db.tenant((trx) => creditAndApply(trx, this.engine, txn.id));
      return { transaction: transactionDto(out.row ?? txn), status: out.status, replay };
    } catch (e) {
      if (e instanceof EngineUnavailableError) {
        throw AppError.internal(
          'Transaction recorded but could not be applied yet (engine unavailable); it will be retried automatically',
          { transaction_id: txn.id, applied: false },
          502,
        );
      }
      throw e;
    }
  }

  async patchBilling(orgId: string, input: BillingPatch) {
    await this.scope.requireChild(orgId);
    if (Object.keys(input).length === 0) throw AppError.invalid('Nothing to update');
    return this.db.tenant(async (trx) => {
      const before = await trx.selectFrom('accounts_balance').selectAll().where('org_id', '=', orgId).forUpdate().executeTakeFirst();
      if (!before) throw AppError.notFound('Balance account');
      const mode = input.billing_mode ?? before.billing_mode;
      let limit = input.credit_limit_micros ?? before.credit_limit_micros;
      if (mode === 'PREPAID') {
        if (input.credit_limit_micros !== undefined && input.credit_limit_micros !== 0) {
          throw AppError.invalid('credit_limit_micros must be 0 for PREPAID billing', { field: 'credit_limit_micros' });
        }
        limit = 0;
      }
      const after = await trx
        .updateTable('accounts_balance')
        .set({
          billing_mode: mode,
          credit_limit_micros: limit,
          ...(input.low_balance_alert_micros !== undefined ? { low_balance_alert_micros: input.low_balance_alert_micros } : {}),
        })
        .where('org_id', '=', orgId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record({ action: 'balance.billing_update', entityType: 'accounts_balance', entityId: orgId, targetOrgId: orgId, before: balanceDto(before), after: balanceDto(after) });
      await this.invalidation.invalidate('accounts_balance', orgId);
      return balanceDto(after);
    });
  }

  async transactions(orgId: string, q: Pagination & { type?: LedgerType }) {
    await this.scope.getOrg(orgId, 'read');
    return this.db.tenant(async (trx) => {
      let base = trx.selectFrom('balance_transactions').where('org_id', '=', orgId);
      if (q.type) base = base.where('type', '=', q.type);
      const [{ total }] = await base.select((eb) => eb.fn.countAll<number>().as('total')).execute();
      const rows = await base.selectAll().orderBy('created_at', 'desc').orderBy('id', 'desc').limit(q.page_size).offset(offsetOf(q)).execute();
      return page(rows.map(transactionDto), total, q);
    });
  }

  /**
   * Background job (privileged pool, documented): retries ledger rows whose engine credit
   * never completed. Safe to repeat — the engine dedupes by idempotency key and the apply
   * step only touches rows with applied_at IS NULL (row-locked).
   */
  async reconcileOnce(minAgeSeconds = RECONCILE_MIN_AGE_SECONDS): Promise<number> {
    if (this.reconciling) return 0;
    this.reconciling = true;
    try {
      const pending = await this.db.privileged
        .selectFrom('balance_transactions')
        .select(['id', 'org_id', 'amount_micros', 'idempotency_key'])
        .where('applied_at', 'is', null)
        .where('idempotency_key', 'is not', null)
        .where('type', 'in', ['TOPUP', 'ADJUSTMENT'])
        .where('created_at', '<', sql<Date>`now() - make_interval(secs => ${minAgeSeconds})`)
        .orderBy('created_at')
        .limit(100)
        .execute();
      let applied = 0;
      for (const t of pending) {
        try {
          const out = await this.db.privileged.transaction().execute((trx) => creditAndApply(trx, this.engine, t.id));
          if (out.row) applied++;
        } catch (e) {
          this.logger.warn(`ledger ${t.id} still unapplied: ${(e as Error).message}`);
          if (e instanceof EngineUnavailableError) break;
        }
      }
      return applied;
    } finally {
      this.reconciling = false;
    }
  }
}

/**
 * Steps 2+3 for one ledger row, inside the caller's transaction: lock the balance row and the
 * ledger row, call the engine (idempotent by key), then record the outcome. Returns
 * `row: undefined` when another worker already applied it.
 */
export async function creditAndApply(
  trx: Transaction<DB> | Kysely<DB>,
  engine: EngineClient,
  txnId: number,
): Promise<{ row: BalanceTransaction | undefined; status: EngineCreditResponse['status'] | 'DUPLICATE' }> {
  const head = await trx.selectFrom('balance_transactions').select(['org_id']).where('id', '=', txnId).executeTakeFirst();
  if (!head) return { row: undefined, status: 'DUPLICATE' };
  // Lock order: balance row first (same as engine hydration), then the ledger row.
  await trx.selectFrom('accounts_balance').select('org_id').where('org_id', '=', head.org_id).forUpdate().executeTakeFirst();
  const row = await trx.selectFrom('balance_transactions').selectAll().where('id', '=', txnId).forUpdate().executeTakeFirst();
  if (!row || row.applied_at || !row.idempotency_key) return { row: undefined, status: 'DUPLICATE' };
  const result = await engine.creditBalance(row.org_id, row.amount_micros, row.idempotency_key);
  return { row: await applyCreditResult(trx, row, result), status: result.status };
}

/** Records the engine outcome for a locked, unapplied ledger row. */
export async function applyCreditResult(trx: Transaction<DB> | Kysely<DB>, row: BalanceTransaction, result: EngineCreditResponse) {
  let balanceAfter: number | null = result.balance_micros ?? null;
  if (result.status === 'NOT_LOADED') {
    // Not in Redis: the snapshot is authoritative, hydration will load it (CONTRACTS §6).
    const b = await trx
      .updateTable('accounts_balance')
      .set((eb) => ({ balance_micros: eb('balance_micros', '+', row.amount_micros) }))
      .where('org_id', '=', row.org_id)
      .returning('balance_micros')
      .executeTakeFirst();
    balanceAfter = b?.balance_micros ?? null;
  }
  return trx
    .updateTable('balance_transactions')
    .set({ applied_at: new Date(), balance_after_micros: balanceAfter })
    .where('id', '=', row.id)
    .returningAll()
    .executeTakeFirstOrThrow();
}
