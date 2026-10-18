import { Body, Controller, Get, Headers, Param, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { currentAuth } from '../common/context';
import { NoRequestTransaction, Roles } from '../common/decorators';
import { UuidPipe } from '../common/uuid.pipe';
import { senderAddress, uuid } from '../common/validation';
import { ZodPipe } from '../common/zod.pipe';
import { MSG_CHANNELS, MSG_STATUSES, MsgStatus } from '../db/types';
import { dateParam, resolveRange } from '../messaging/dates';
import { MAX_RECIPIENTS, SendService, parseIdempotencyKey } from '../messaging/send.service';
import { MessageFilters, MessagesService } from './messages.service';

const statusList = z
  .string()
  .transform((v) => v.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))
  .pipe(z.array(z.enum(MSG_STATUSES)).max(MSG_STATUSES.length));

export const messageFilterQuery = z.object({
  org_id: uuid.optional(),
  from_date: dateParam.optional(),
  to_date: dateParam.optional(),
  status: statusList.optional(),
  destination: z.string().trim().min(1).max(32).optional(),
  source: z.string().trim().min(1).max(21).optional(),
  route_id: uuid.optional(),
  campaign_id: uuid.optional(),
  channel: z.enum(MSG_CHANNELS).optional(),
  q: z.string().trim().min(1).max(200).optional(),
});
const listQuery = messageFilterQuery.extend({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export const sendBody = z
  .object({
    to: z.union([z.string().trim().min(1).max(20_000), z.array(z.string().trim().min(1).max(32)).min(1).max(MAX_RECIPIENTS)]),
    from: senderAddress,
    text: z.string().min(1).max(5000),
    route_id: uuid.optional(),
  })
  .strict();

/** Default window 7 days, at most 366 (every CDR query is date-bounded). */
export function toFilters(q: z.infer<typeof messageFilterQuery>): MessageFilters {
  const { from, to } = resolveRange(q.from_date, q.to_date, 7, 366);
  return {
    from,
    to,
    status: q.status as MsgStatus[] | undefined,
    destination: q.destination,
    source: q.source,
    route_id: q.route_id,
    campaign_id: q.campaign_id,
    channel: q.channel,
    q: q.q,
  };
}

@ApiTags('messages')
@Controller('api/messages')
export class MessagesController {
  constructor(
    private readonly messages: MessagesService,
    private readonly sender: SendService,
  ) {}

  /** Web quick send (channel WEB) as the acting org. No DB work: no request transaction around the engine call. */
  @Post('send')
  @Roles('RESELLER', 'CLIENT')
  @NoRequestTransaction()
  send(@Body(new ZodPipe(sendBody)) body: z.infer<typeof sendBody>, @Headers('idempotency-key') idem?: string) {
    return this.sender.send({
      orgId: currentAuth().orgId,
      channel: 'WEB',
      to: body.to,
      from: body.from,
      text: body.text,
      routeId: body.route_id,
      idempotencyKey: parseIdempotencyKey(idem),
    });
  }

  @Get()
  list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.messages.list(q.org_id, toFilters(q), q.limit, q.cursor);
  }

  @Get('export')
  @NoRequestTransaction()
  async export(@Query(new ZodPipe(messageFilterQuery)) q: z.infer<typeof messageFilterQuery>, @Res() res: Response): Promise<void> {
    await this.messages.exportCsv(q.org_id, toFilters(q), res);
  }

  @Get(':id')
  get(@Param('id', UuidPipe) id: string) {
    return this.messages.get(id);
  }
}
