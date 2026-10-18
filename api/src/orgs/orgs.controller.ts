import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { paginationSchema } from '../common/pagination';
import { UuidPipe } from '../common/uuid.pipe';
import { email, password, uuid } from '../common/validation';
import { ZodPipe } from '../common/zod.pipe';
import { BILLING_MODES, ORG_STATUSES } from '../db/types';
import { OrgsService } from './orgs.service';

const listSchema = paginationSchema.extend({
  role: z.enum(['RESELLER', 'CLIENT']).optional(),
  parent_id: uuid.optional(),
  status: z.enum(ORG_STATUSES).optional(),
  q: z.string().trim().min(1).max(200).optional(),
});

const limit = z.number().int().positive().max(2_000_000_000);
const domain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?=.{1,253}$)([a-z0-9](-?[a-z0-9])*\.)+[a-z]{2,63}$/, 'must be a hostname');

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    email,
    password,
    full_name: z.string().trim().max(200).optional(),
    brand_name: z.string().trim().max(100).optional(),
    max_tps: z.number().int().positive().max(100_000).optional(),
    daily_limit: limit.nullable().optional(),
    monthly_limit: limit.nullable().optional(),
    billing_mode: z.enum(BILLING_MODES).optional(),
    credit_limit_micros: z.number().int().safe().nonnegative().optional(),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, 'must be an ISO-4217 code')
      .optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    brand_name: z.string().trim().max(100).nullable().optional(),
    max_tps: z.number().int().positive().max(100_000).optional(),
    daily_limit: limit.nullable().optional(),
    monthly_limit: limit.nullable().optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    whitelabel_domain: domain.nullable().optional(),
  })
  .strict();

const suspendSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const channelsSchema = z
  .object({
    sending_enabled: z.boolean().optional(),
    api_enabled: z.boolean().optional(),
    smpp_enabled: z.boolean().optional(),
    web_enabled: z.boolean().optional(),
  })
  .strict();
const createUserSchema = z.object({ email, password, full_name: z.string().trim().max(200).optional() }).strict();
const resetPasswordSchema = z.object({ new_password: password }).strict();
const patchUserSchema = z
  .object({ is_active: z.boolean().optional(), full_name: z.string().trim().max(200).nullable().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

@Controller('api/orgs')
export class OrgsController {
  constructor(private readonly orgs: OrgsService) {}

  @Get()
  list(@Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    return this.orgs.list(q);
  }

  @Post()
  create(@Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>) {
    return this.orgs.create(body);
  }

  @Get(':id')
  get(@Param('id', UuidPipe) id: string) {
    return this.orgs.get(id);
  }

  @Patch(':id')
  patch(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(patchSchema)) body: z.infer<typeof patchSchema>) {
    return this.orgs.patch(id, body);
  }

  @Post(':id/suspend')
  @HttpCode(200)
  suspend(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(suspendSchema)) body: z.infer<typeof suspendSchema>) {
    return this.orgs.suspend(id, body.reason);
  }

  @Post(':id/activate')
  @HttpCode(200)
  activate(@Param('id', UuidPipe) id: string) {
    return this.orgs.activate(id);
  }

  @Patch(':id/channels')
  channels(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(channelsSchema)) body: z.infer<typeof channelsSchema>) {
    return this.orgs.channels(id, body);
  }

  @Get(':id/users')
  users(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(paginationSchema)) p: z.infer<typeof paginationSchema>) {
    return this.orgs.listUsers(id, p);
  }

  @Post(':id/users')
  createUser(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(createUserSchema)) body: z.infer<typeof createUserSchema>) {
    return this.orgs.createUser(id, body);
  }

  @Post(':id/users/:uid/reset-password')
  @HttpCode(200)
  resetPassword(
    @Param('id', UuidPipe) id: string,
    @Param('uid', UuidPipe) uid: string,
    @Body(new ZodPipe(resetPasswordSchema)) body: z.infer<typeof resetPasswordSchema>,
  ) {
    return this.orgs.resetUserPassword(id, uid, body.new_password);
  }

  @Patch(':id/users/:uid')
  patchUser(@Param('id', UuidPipe) id: string, @Param('uid', UuidPipe) uid: string, @Body(new ZodPipe(patchUserSchema)) body: z.infer<typeof patchUserSchema>) {
    return this.orgs.patchUser(id, uid, body);
  }
}
