import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { EngineClient } from '../engine/engine-client.service';
import type { EngineConnectionStatus } from '../engine/engine.types';
import { microsToDecimal } from '../messaging/money';
import { RedisService } from '../redis/redis.module';
import { AlertSender } from './alert-sender.service';

export interface AlertOutcome {
  kind: 'low_balance' | 'route_down';
  org_id: string;
  subject_id: string;
  channels: string[];
}

interface Target {
  orgId: string;
  emailEnabled: boolean;
  emailTo: string[];
  telegramEnabled: boolean;
  telegramChatId: string | null;
}

/**
 * Notification worker (background job → privileged pool, documented use: it scans every tenant).
 *   low_balance  orgs whose available balance (balance + credit limit) ≤ low_balance_alert_micros
 *                and notification_settings.low_balance (default on); live engine balance confirms
 *                the synced snapshot when reachable.
 *   route_down   (admin org) enabled routes with no enabled connection BOUND per engine status.
 * Dedupe: Redis `alert:<kind>:<org_id>:<subject>` SET NX EX ALERT_DEDUPE_SECONDS (default 6h), so
 * across all api instances an org gets at most one alert per condition per window. The claim
 * is released when no channel accepted the alert, so it is retried on the next pass.
 * Recipients: settings.email_to, else the org's active users; Telegram when enabled + chat id.
 */
@Injectable()
export class AlertsWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlertsWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly engine: EngineClient,
    private readonly sender: AlertSender,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    const every = this.config.ALERTS_INTERVAL_MS;
    if (every > 0) {
      this.timer = setInterval(() => {
        if (this.running) return;
        this.running = this.tick()
          .catch((e) => this.logger.warn(`alerts tick failed: ${(e as Error).message}`))
          .finally(() => {
            this.running = null;
          });
      }, every);
      this.timer.unref();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  async tick(): Promise<AlertOutcome[]> {
    if (!this.sender.emailAvailable && !this.sender.telegramAvailable) return [];
    const out: AlertOutcome[] = [];
    out.push(...(await this.lowBalance()));
    out.push(...(await this.routeDown()));
    return out;
  }

  async lowBalance(): Promise<AlertOutcome[]> {
    const rows = await this.db.privileged
      .selectFrom('accounts_balance as b')
      .innerJoin('organizations as o', 'o.id', 'b.org_id')
      .leftJoin('notification_settings as ns', 'ns.org_id', 'b.org_id')
      .select([
        'b.org_id',
        'o.name',
        'b.balance_micros',
        'b.credit_limit_micros',
        'b.low_balance_alert_micros',
        sql<string>`trim(b.currency)`.as('currency'),
        sql<boolean>`coalesce(ns.email_enabled, true)`.as('email_enabled'),
        sql<string[]>`coalesce(ns.email_to, '{}')`.as('email_to'),
        sql<boolean>`coalesce(ns.telegram_enabled, false)`.as('telegram_enabled'),
        'ns.telegram_chat_id',
      ])
      .where('b.low_balance_alert_micros', 'is not', null)
      .where('o.status', '=', 'ACTIVE')
      .where(sql<boolean>`coalesce(ns.low_balance, true)`)
      .where(sql<boolean>`b.balance_micros + b.credit_limit_micros <= b.low_balance_alert_micros`)
      .limit(1000)
      .execute();

    const out: AlertOutcome[] = [];
    for (const r of rows) {
      const threshold = r.low_balance_alert_micros as number;
      let available = r.balance_micros + r.credit_limit_micros;
      try {
        const live = await this.engine.getBalance(r.org_id);
        available = live.balance_micros + live.credit_limit_micros;
      } catch {
        // engine unreachable / not loaded: the synced snapshot is the best we have
      }
      if (available > threshold) continue;
      const text =
        `Low balance on "${r.name}": ${microsToDecimal(available)} ${r.currency} available ` +
        `(alert threshold ${microsToDecimal(threshold)} ${r.currency}). Top up to avoid interrupted sending.`;
      const sent = await this.notify(
        { orgId: r.org_id, emailEnabled: r.email_enabled, emailTo: r.email_to, telegramEnabled: r.telegram_enabled, telegramChatId: r.telegram_chat_id },
        `alert:low_balance:${r.org_id}`,
        `[SMS Gateway] Low balance: ${r.name}`,
        text,
      );
      if (sent) out.push({ kind: 'low_balance', org_id: r.org_id, subject_id: r.org_id, channels: sent });
    }
    return out;
  }

  async routeDown(): Promise<AlertOutcome[]> {
    const admin = await this.db.privileged
      .selectFrom('organizations as o')
      .leftJoin('notification_settings as ns', 'ns.org_id', 'o.id')
      .select([
        'o.id',
        sql<boolean>`coalesce(ns.route_down, true)`.as('route_down'),
        sql<boolean>`coalesce(ns.email_enabled, true)`.as('email_enabled'),
        sql<string[]>`coalesce(ns.email_to, '{}')`.as('email_to'),
        sql<boolean>`coalesce(ns.telegram_enabled, false)`.as('telegram_enabled'),
        'ns.telegram_chat_id',
      ])
      .where('o.role', '=', 'SUPER_ADMIN')
      .executeTakeFirst();
    if (!admin || !admin.route_down) return [];

    let status: EngineConnectionStatus[];
    try {
      status = await this.engine.connectionsStatus();
    } catch (e) {
      this.logger.warn(`route-down check skipped, engine unreachable: ${(e as Error).message}`);
      return [];
    }
    const bound = new Set(status.filter((c) => c.state === 'BOUND').map((c) => c.connection_id));
    const routes = await this.db.privileged
      .selectFrom('routes as r')
      .leftJoin('route_connections as rc', (j) => j.onRef('rc.route_id', '=', 'r.id').on('rc.enabled', '=', true))
      .leftJoin('upstream_connections as uc', (j) => j.onRef('uc.id', '=', 'rc.connection_id').on('uc.enabled', '=', true))
      .select(['r.id', 'r.name', sql<string[]>`coalesce(array_agg(uc.id::text) filter (where uc.id is not null), '{}')`.as('connections')])
      .where('r.enabled', '=', true)
      .groupBy(['r.id', 'r.name'])
      .execute();

    const out: AlertOutcome[] = [];
    for (const r of routes) {
      if (r.connections.some((id) => bound.has(id))) continue;
      const why = r.connections.length === 0 ? 'it has no enabled upstream connection' : `none of its ${r.connections.length} enabled connection(s) is bound`;
      const sent = await this.notify(
        { orgId: admin.id, emailEnabled: admin.email_enabled, emailTo: admin.email_to, telegramEnabled: admin.telegram_enabled, telegramChatId: admin.telegram_chat_id },
        `alert:route_down:${admin.id}:${r.id}`,
        `[SMS Gateway] Route down: ${r.name}`,
        `Route "${r.name}" cannot deliver: ${why}. Messages on this route will fail over or be rejected.`,
      );
      if (sent) out.push({ kind: 'route_down', org_id: admin.id, subject_id: r.id, channels: sent });
    }
    return out;
  }

  /** Claims the dedupe key, delivers on every enabled channel; returns the channels that accepted it (null = nothing sent). */
  private async notify(t: Target, dedupeKey: string, subject: string, text: string): Promise<string[] | null> {
    const wantEmail = t.emailEnabled && this.sender.emailAvailable;
    const wantTelegram = t.telegramEnabled && !!t.telegramChatId && this.sender.telegramAvailable;
    if (!wantEmail && !wantTelegram) return null;

    const claimed = await this.redis.client.set(dedupeKey, new Date().toISOString(), 'EX', this.config.ALERT_DEDUPE_SECONDS, 'NX');
    if (claimed !== 'OK') return null;

    const channels: string[] = [];
    if (wantEmail) {
      const to = t.emailTo.length > 0 ? t.emailTo : await this.orgEmails(t.orgId);
      if (await this.sender.email(to, subject, text)) channels.push('email');
    }
    if (wantTelegram && (await this.sender.telegram(t.telegramChatId as string, `${subject}\n\n${text}`))) channels.push('telegram');
    if (channels.length === 0) {
      await this.redis.client.del(dedupeKey);
      return null;
    }
    this.logger.log(`${dedupeKey} sent via ${channels.join('+')}`);
    return channels;
  }

  private async orgEmails(orgId: string): Promise<string[]> {
    const users = await this.db.privileged.selectFrom('users').select('email').where('org_id', '=', orgId).where('is_active', '=', true).orderBy('created_at').limit(10).execute();
    return users.map((u) => u.email);
  }
}
