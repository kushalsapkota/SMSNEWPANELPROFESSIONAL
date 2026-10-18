import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { NoRequestTransaction } from '../common/decorators';
import { paginationSchema } from '../common/pagination';
import { orgIdQuery, scopedListQuery } from '../common/scoped-query';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { WebhooksService } from './webhooks.service';

export const WEBHOOK_EVENTS = ['dlr'] as const;
const url = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((v) => /^https?:\/\//i.test(v), 'must be an http(s) URL');
const fields = {
  url,
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length),
  max_retries: z.number().int().min(0).max(20),
  enabled: z.boolean(),
};
const createSchema = z.object(fields).partial({ events: true, max_retries: true, enabled: true }).strict();
const patchSchema = z
  .object({ ...fields, rotate_secret: z.boolean() })
  .partial()
  .strict();

@Controller('api/webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get()
  list(@Query(new ZodPipe(scopedListQuery)) q: z.infer<typeof scopedListQuery>) {
    return this.webhooks.list(q);
  }

  @Post()
  create(@Query(new ZodPipe(orgIdQuery)) q: z.infer<typeof orgIdQuery>, @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>) {
    return this.webhooks.create(q.org_id, body);
  }

  @Patch(':id')
  patch(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(patchSchema)) body: z.infer<typeof patchSchema>) {
    return this.webhooks.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id', UuidPipe) id: string) {
    return this.webhooks.remove(id);
  }

  @Post(':id/test')
  @HttpCode(200)
  @NoRequestTransaction()
  test(@Param('id', UuidPipe) id: string) {
    return this.webhooks.test(id);
  }

  @Get(':id/deliveries')
  deliveries(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(paginationSchema)) q: z.infer<typeof paginationSchema>) {
    return this.webhooks.deliveries(id, q);
  }
}
