import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Roles } from '../common/decorators';
import { orgIdQuery, scopedListQuery } from '../common/scoped-query';
import { queryBool } from '../common/validation';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { CONTENT_STATUSES } from '../db/types';
import { ApprovedContentService } from './approved-content.service';

const listSchema = scopedListQuery.extend({
  status: z.enum(CONTENT_STATUSES).optional(),
  include_children: queryBool.optional(),
});
const createSchema = z.object({ content: z.string().trim().min(1).max(2000) }).strict();

@Controller('api/approved-content')
export class ApprovedContentController {
  constructor(private readonly content: ApprovedContentService) {}

  @Get()
  list(@Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    return this.content.list(q);
  }

  @Post()
  create(@Query(new ZodPipe(orgIdQuery)) q: z.infer<typeof orgIdQuery>, @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>) {
    return this.content.create(q.org_id, body);
  }

  @Delete(':id')
  remove(@Param('id', UuidPipe) id: string) {
    return this.content.remove(id);
  }

  @Post(':id/approve')
  @Roles('SUPER_ADMIN')
  @HttpCode(200)
  approve(@Param('id', UuidPipe) id: string) {
    return this.content.review(id, 'APPROVED');
  }

  @Post(':id/reject')
  @Roles('SUPER_ADMIN')
  @HttpCode(200)
  reject(@Param('id', UuidPipe) id: string) {
    return this.content.review(id, 'REJECTED');
  }
}
