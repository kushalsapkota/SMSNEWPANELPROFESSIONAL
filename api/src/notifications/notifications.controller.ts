import { Body, Controller, Get, Injectable, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/errors';
import { orgIdQuery } from '../common/scoped-query';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.service';
import { ScopeService } from '../tenancy/scope.service';

const settingsSchema = z
  .object({
    email_enabled: z.boolean(),
    email_to: z.array(z.string().trim().toLowerCase().email().max(254)).max(10),
    telegram_enabled: z.boolean(),
    telegram_chat_id: z.string().trim().regex(/^-?[0-9]{1,20}$|^@[A-Za-z0-9_]{5,32}$/, 'must be a numeric chat id or @channel').nullable(),
    low_balance: z.boolean(),
    route_down: z.boolean(),
  })
  .partial()
  .strict()
  .refine((v) => !(v.telegram_enabled && v.telegram_chat_id === null), 'telegram_chat_id is required when telegram is enabled');

type SettingsInput = z.infer<typeof settingsSchema>;

const DEFAULTS = { email_enabled: true, email_to: [] as string[], telegram_enabled: false, telegram_chat_id: null as string | null, low_balance: true, route_down: true };

@Injectable()
export class NotificationsService {
  constructor(
    private readonly db: DbService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
  ) {}

  async get(orgIdParam?: string) {
    const org = await this.scope.resolve(orgIdParam, 'read');
    const row = await this.db.tenant((trx) => trx.selectFrom('notification_settings').selectAll().where('org_id', '=', org.id).executeTakeFirst());
    return row ?? { org_id: org.id, ...DEFAULTS, updated_at: null };
  }

  async put(orgIdParam: string | undefined, input: SettingsInput) {
    const org = await this.scope.resolve(orgIdParam, 'write');
    return this.db.tenant(async (trx) => {
      const before = await trx.selectFrom('notification_settings').selectAll().where('org_id', '=', org.id).executeTakeFirst();
      const merged = { ...DEFAULTS, ...(before ?? {}), ...input };
      if (merged.telegram_enabled && !merged.telegram_chat_id) {
        throw AppError.invalid('telegram_chat_id is required when telegram is enabled', { field: 'telegram_chat_id' });
      }
      const values = {
        email_enabled: merged.email_enabled,
        email_to: merged.email_to,
        telegram_enabled: merged.telegram_enabled,
        telegram_chat_id: merged.telegram_chat_id,
        low_balance: merged.low_balance,
        route_down: merged.route_down,
        updated_at: new Date(),
      };
      const after = await trx
        .insertInto('notification_settings')
        .values({ org_id: org.id, ...values })
        .onConflict((oc) => oc.column('org_id').doUpdateSet(values))
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record({ action: 'notifications.update', entityType: 'notification_settings', entityId: org.id, targetOrgId: org.id, before: before ?? null, after });
      return after;
    });
  }
}

@Controller('api/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('settings')
  get(@Query(new ZodPipe(orgIdQuery)) q: z.infer<typeof orgIdQuery>) {
    return this.notifications.get(q.org_id);
  }

  @Put('settings')
  put(@Query(new ZodPipe(orgIdQuery)) q: z.infer<typeof orgIdQuery>, @Body(new ZodPipe(settingsSchema)) body: SettingsInput) {
    return this.notifications.put(q.org_id, body);
  }
}
