import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { orgIdQuery, scopedListQuery } from '../common/scoped-query';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { BIND_TYPES } from '../db/types';
import { SmppAccountsService } from './smpp-accounts.service';

const smppPassword = z.string().min(1).max(8, 'SMPP 3.4 passwords are at most 8 characters');
const fields = {
  max_binds: z.number().int().min(1).max(100),
  max_tps: z.number().int().positive().max(100_000).nullable(),
  allowed_bind_types: z.array(z.enum(BIND_TYPES)).min(1).max(3).refine((v) => new Set(v).size === v.length, 'duplicate bind types'),
  enabled: z.boolean(),
};
const createSchema = z
  .object({ system_id: z.string().min(1).max(15).regex(/^[A-Za-z0-9_.-]+$/, 'letters, digits, _ . - only'), password: smppPassword, ...fields })
  .partial({ max_binds: true, max_tps: true, allowed_bind_types: true, enabled: true })
  .strict();
const patchSchema = z.object(fields).partial().strict();
const passwordSchema = z.object({ password: smppPassword }).strict();

@Controller('api/smpp-accounts')
export class SmppAccountsController {
  constructor(private readonly accounts: SmppAccountsService) {}

  @Get()
  list(@Query(new ZodPipe(scopedListQuery)) q: z.infer<typeof scopedListQuery>) {
    return this.accounts.list(q);
  }

  @Post()
  create(@Query(new ZodPipe(orgIdQuery)) q: z.infer<typeof orgIdQuery>, @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>) {
    return this.accounts.create(q.org_id, body);
  }

  @Patch(':id')
  patch(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(patchSchema)) body: z.infer<typeof patchSchema>) {
    return this.accounts.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id', UuidPipe) id: string) {
    return this.accounts.remove(id);
  }

  @Post(':id/password')
  @HttpCode(200)
  password(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(passwordSchema)) body: z.infer<typeof passwordSchema>) {
    return this.accounts.rotatePassword(id, body.password);
  }
}
