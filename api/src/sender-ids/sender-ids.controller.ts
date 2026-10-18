import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { orgIdQuery, scopedListQuery } from '../common/scoped-query';
import { UuidPipe } from '../common/uuid.pipe';
import { queryBool, senderAddress, uuid } from '../common/validation';
import { ZodPipe } from '../common/zod.pipe';
import { SENDER_STATUSES } from '../db/types';
import { SenderIdsService } from './sender-ids.service';

const listSchema = scopedListQuery.extend({ status: z.enum(SENDER_STATUSES).optional(), include_children: queryBool.optional() });
const createSchema = z.object({ sender: senderAddress, route_id: uuid.nullable().optional() }).strict();

@Controller('api/sender-ids')
export class SenderIdsController {
  constructor(private readonly senderIds: SenderIdsService) {}

  @Get()
  list(@Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    return this.senderIds.list(q);
  }

  @Post()
  create(@Query(new ZodPipe(orgIdQuery)) q: z.infer<typeof orgIdQuery>, @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>) {
    return this.senderIds.create(q.org_id, body);
  }

  @Delete(':id')
  remove(@Param('id', UuidPipe) id: string) {
    return this.senderIds.remove(id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(@Param('id', UuidPipe) id: string) {
    return this.senderIds.review(id, 'APPROVED');
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(@Param('id', UuidPipe) id: string) {
    return this.senderIds.review(id, 'REJECTED');
  }
}
