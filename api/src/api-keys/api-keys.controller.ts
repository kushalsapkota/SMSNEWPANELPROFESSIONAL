import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { orgIdQuery, scopedListQuery } from '../common/scoped-query';
import { UuidPipe } from '../common/uuid.pipe';
import { queryBool } from '../common/validation';
import { ZodPipe } from '../common/zod.pipe';
import { ApiKeysService } from './api-keys.service';

export const API_KEY_SCOPES = ['sms:send', 'sms:read', 'balance:read'] as const;
const listSchema = scopedListQuery.extend({ include_revoked: queryBool.optional() });
const createSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).max(API_KEY_SCOPES.length).optional(),
    expires_at: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

@Controller('api/api-keys')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  list(@Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    return this.keys.list(q);
  }

  @Post()
  create(@Query(new ZodPipe(orgIdQuery)) q: z.infer<typeof orgIdQuery>, @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>) {
    return this.keys.create(q.org_id, body);
  }

  @Delete(':id')
  revoke(@Param('id', UuidPipe) id: string) {
    return this.keys.revoke(id);
  }
}
