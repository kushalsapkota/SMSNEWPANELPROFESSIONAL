import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Transaction, sql } from 'kysely';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import type { DB } from '../db/types';
import { EngineClient, EngineUnavailableError } from '../engine/engine-client.service';
import type { EngineBatchResult, EngineSubmitRequest } from '../engine/engine.types';
import { ENGINE_BATCH_MAX, isSubmitOk } from '../messaging/send.service';
import { renderBody } from './recipients';

/** Rejections that concern the whole org, not the recipient: keep the recipient pending and pause. */
const ORG_LEVEL = new Set(['INSUFFICIENT_FUNDS', 'ACCOUNT_SUSPENDED', 'SENDING_DISABLED', 'CHANNEL_DISABLED', 'DAILY_LIMIT', 'MONTHLY_LIMIT']);
/** Transient: keep pending, retry on a later tick. */
const RETRYABLE = new Set(['RATE_LIMITED']);

/** Max campaigns handled per tick (each gets at most one chunk). */
const CAMPAIGNS_PER_TICK = 50;

export interface ChunkOutcome {
  campaignId: string;
  submitted: number;
  failed: number;
  deferred: number;
  status: string;
}

/**
 * In-process campaign sender. Background job → privileged pool (documented use): it acts for
 * every tenant and must see the true org_effective_state.
 *
 * Multi-instance safety: each chunk runs in one transaction that holds the campaign row via
 * `SELECT … FOR UPDATE SKIP LOCKED`, so a campaign is processed by one api instance at a
 * time and pause/cancel (conditional UPDATEs) serialise behind the in-flight chunk.
 *
 * Pacing: a chunk is at most the org's effective_max_tps recipients (≤1000) and a campaign is
 * picked only when its updated_at (= start of its previous chunk's transaction, set by the
 * touch trigger) is ≥ 1s old, which bounds every campaign to ~max_tps messages/s across all
 * instances. The engine's per-org limiter still has the final word (RATE_LIMITED → retried).
 *
 * Delivery guarantee: at-least-once per chunk. If the process dies after the engine accepted a
 * chunk but before its transaction commits, that chunk is submitted again.
 */
@Injectable()
export class CampaignWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CampaignWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  private stopped = false;
  /** Minimum gap between two chunks of one campaign (1s = max_tps pacing). */
  paceMs = 1000;

  constructor(
    private readonly db: DbService,
    private readonly engine: EngineClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    const every = this.config.CAMPAIGN_WORKER_INTERVAL_MS;
    if (every > 0) {
      this.timer = setInterval(() => {
        if (this.running || this.stopped) return;
        this.running = this.tick()
          .catch((e) => this.logger.warn(`campaign tick failed: ${(e as Error).message}`))
          .finally(() => {
            this.running = null;
          });
      }, every);
      this.timer.unref();
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  /** One pass: promote due scheduled campaigns, then send one chunk for each runnable campaign. */
  async tick(): Promise<ChunkOutcome[]> {
    await this.promoteDue();
    const outcomes: ChunkOutcome[] = [];
    const seen: string[] = [];
    for (let i = 0; i < CAMPAIGNS_PER_TICK && !this.stopped; i++) {
      const out = await this.db.privileged.transaction().execute((trx) => this.processOne(trx, seen));
      if (!out) break;
      seen.push(out.campaignId);
      outcomes.push(out);
    }
    return outcomes;
  }

  private async promoteDue(): Promise<void> {
    await this.db.privileged
      .updateTable('campaigns')
      .set({ status: 'RUNNING', started_at: sql<Date>`coalesce(started_at, now())` })
      .where('id', 'in', (eb) =>
        eb.selectFrom('campaigns').select('id').where('status', '=', 'SCHEDULED').where('scheduled_at', '<=', sql<Date>`now()`).limit(100).forUpdate().skipLocked(),
      )
      .where('status', '=', 'SCHEDULED')
      .execute();
  }

  private async processOne(trx: Transaction<DB>, exclude: string[]): Promise<ChunkOutcome | null> {
    let q = trx
      .selectFrom('campaigns')
      .select(['id', 'org_id', 'source_addr', 'body', 'total', 'submitted', 'failed'])
      .where('status', '=', 'RUNNING')
      .where('updated_at', '<=', sql<Date>`now() - make_interval(secs => ${this.paceMs / 1000})`);
    if (exclude.length > 0) q = q.where('id', 'not in', exclude);
    const c = await q.orderBy('updated_at').limit(1).forUpdate().skipLocked().executeTakeFirst();
    if (!c) return null;

    const state = await trx
      .selectFrom('app.org_effective_state')
      .select(['is_active', 'can_send', 'effective_max_tps'])
      .where('id', '=', c.org_id)
      .executeTakeFirst();
    if (!state || !state.is_active || !state.can_send) {
      const reason = !state || !state.is_active ? 'ACCOUNT_SUSPENDED' : 'SENDING_DISABLED';
      await this.pause(trx, c.id, c.org_id, reason);
      return { campaignId: c.id, submitted: 0, failed: 0, deferred: 0, status: 'PAUSED' };
    }

    const chunk = Math.max(1, Math.min(state.effective_max_tps, ENGINE_BATCH_MAX));
    const recips = await trx
      .selectFrom('campaign_recipients')
      .select(['seq', 'destination', 'vars'])
      .where('campaign_id', '=', c.id)
      .where('message_id', 'is', null)
      .where('error_code', 'is', null)
      .orderBy('seq')
      .limit(chunk)
      .execute();
    if (recips.length === 0) {
      const status = await this.finish(trx, c.id, c.submitted);
      return { campaignId: c.id, submitted: 0, failed: 0, deferred: 0, status };
    }

    const items: EngineSubmitRequest[] = recips.map((r) => ({
      org_id: c.org_id,
      channel: 'WEB',
      source: c.source_addr,
      destination: r.destination,
      text: renderBody(c.body, (r.vars ?? {}) as Record<string, unknown>),
      campaign_id: c.id,
    }));

    let results: EngineBatchResult[];
    try {
      results = await this.engine.submitBatch(items);
    } catch (e) {
      if (e instanceof EngineUnavailableError) {
        // Nothing was recorded; bump updated_at so the retry is paced like a chunk.
        this.logger.warn(`campaign ${c.id}: engine unavailable, will retry: ${e.message}`);
        await trx.updateTable('campaigns').set({ updated_at: sql<Date>`now()` }).where('id', '=', c.id).execute();
        return { campaignId: c.id, submitted: 0, failed: 0, deferred: recips.length, status: 'RUNNING' };
      }
      throw e;
    }

    const updates: { seq: number; message_id: string | null; error_code: string | null }[] = [];
    let submitted = 0;
    let failed = 0;
    let deferred = 0;
    let pauseReason: string | null = null;
    recips.forEach((r, i) => {
      const res = results[i];
      if (res && isSubmitOk(res)) {
        updates.push({ seq: r.seq, message_id: res.message_id, error_code: null });
        submitted += 1;
        return;
      }
      const code = (res as { error_code?: string } | undefined)?.error_code ?? 'INTERNAL';
      if (ORG_LEVEL.has(code)) {
        pauseReason ??= code;
        deferred += 1;
      } else if (RETRYABLE.has(code)) {
        deferred += 1;
      } else {
        updates.push({ seq: r.seq, message_id: null, error_code: code });
        failed += 1;
      }
    });

    if (updates.length > 0) {
      const values = sql.join(updates.map((u) => sql`(${u.seq}::int, ${u.message_id}::uuid, ${u.error_code}::text)`));
      await sql`
        update campaign_recipients r
           set message_id = v.message_id, error_code = v.error_code
          from (values ${values}) as v(seq, message_id, error_code)
         where r.campaign_id = ${c.id}::uuid and r.seq = v.seq`.execute(trx);
    }
    await trx
      .updateTable('campaigns')
      .set({ submitted: sql<number>`submitted + ${submitted}`, failed: sql<number>`failed + ${failed}`, updated_at: sql<Date>`now()` })
      .where('id', '=', c.id)
      .execute();

    let status = 'RUNNING';
    if (pauseReason) {
      await this.pause(trx, c.id, c.org_id, pauseReason);
      status = 'PAUSED';
    } else if (deferred === 0 && recips.length < chunk) {
      status = await this.finish(trx, c.id, c.submitted + submitted);
    }
    return { campaignId: c.id, submitted, failed, deferred, status };
  }

  /** COMPLETED when anything went out, FAILED when every recipient was rejected. */
  private async finish(trx: Transaction<DB>, id: string, submittedTotal: number): Promise<string> {
    const pending = await trx
      .selectFrom('campaign_recipients')
      .select('seq')
      .where('campaign_id', '=', id)
      .where('message_id', 'is', null)
      .where('error_code', 'is', null)
      .limit(1)
      .executeTakeFirst();
    if (pending) return 'RUNNING';
    const status = submittedTotal > 0 ? 'COMPLETED' : 'FAILED';
    await trx.updateTable('campaigns').set({ status, finished_at: sql<Date>`now()` }).where('id', '=', id).where('status', '=', 'RUNNING').execute();
    return status;
  }

  /** Auto-pause on an org-level rejection; the reason is recorded in the audit log for the UI. */
  private async pause(trx: Transaction<DB>, id: string, orgId: string, reason: string): Promise<void> {
    await trx.updateTable('campaigns').set({ status: 'PAUSED' }).where('id', '=', id).where('status', '=', 'RUNNING').execute();
    await trx
      .insertInto('audit_logs')
      .values({
        actor_user_id: null,
        actor_org_id: null,
        target_org_id: orgId,
        action: 'campaign.auto_pause',
        entity_type: 'campaign',
        entity_id: id,
        after: JSON.stringify({ status: 'PAUSED', reason }),
      })
      .execute();
    this.logger.log(`campaign ${id} paused: ${reason}`);
  }
}
