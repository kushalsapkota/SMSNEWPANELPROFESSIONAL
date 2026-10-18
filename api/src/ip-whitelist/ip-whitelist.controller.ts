import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { orgIdQuery, scopedListQuery } from '../common/scoped-query';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { IP_SCOPES } from '../db/types';
import { IpWhitelistService } from './ip-whitelist.service';

const listSchema = scopedListQuery.extend({ scope: z.enum(IP_SCOPES).optional() });
const createSchema = z
  .object({ cidr: z.string().trim().min(2).max(64), scope: z.enum(IP_SCOPES).default('ALL'), note: z.string().trim().max(500).nullable().optional() })
  .strict();

@Controller('api/ip-whitelist')
export class IpWhitelistController {
  constructor(private readonly whitelist: IpWhitelistService) {}

  @Get()
  list(@Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    return this.whitelist.list(q);
  }

  @Post()
  create(@Query(new ZodPipe(orgIdQuery)) q: z.infer<typeof orgIdQuery>, @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>) {
    return this.whitelist.create(q.org_id, body);
  }

  @Delete(':id')
  remove(@Param('id', UuidPipe) id: string) {
    return this.whitelist.remove(id);
  }
}
