import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { NoRequestTransaction, Roles } from '../common/decorators';
import { paginationSchema } from '../common/pagination';
import { UuidPipe } from '../common/uuid.pipe';
import { digitsPrefix, queryBool } from '../common/validation';
import { ZodPipe, parseOrThrow } from '../common/zod.pipe';
import { BIND_TYPES, CONNECTION_KINDS, MULTIPART_MODES } from '../db/types';
import { ConnectionsService } from './connections.service';
import { adapterId, credentialMap, settingMap } from './http-adapters';

const smallint = (min: number, max: number) => z.number().int().min(min).max(max);
const base = {
  name: z.string().trim().min(1).max(100),
  host: z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.:\-[\]]+$/, 'must be a hostname or IP'),
  port: smallint(1, 65535),
  use_tls: z.boolean(),
  system_id: z.string().min(1).max(15),
  password: z.string().min(1).max(8, 'SMPP 3.4 passwords are at most 8 characters'),
  system_type: z.string().max(12),
  bind_type: z.enum(BIND_TYPES),
  sessions: smallint(1, 64),
  max_tps: z.number().int().positive().max(1_000_000),
  window_size: smallint(1, 1000),
  enquire_link_interval_s: smallint(1, 3600),
  reconnect_min_s: smallint(1, 3600),
  reconnect_max_s: smallint(1, 32767),
  submit_timeout_ms: z.number().int().min(100).max(600_000),
  request_dlr: z.boolean(),
  multipart_mode: z.enum(MULTIPART_MODES),
  default_data_coding: smallint(0, 255),
  enabled: z.boolean(),
  notes: z.string().max(2000).nullable(),
};
const createSchema = z
  .object({ ...base, kind: z.literal('SMPP') })
  .partial()
  .required({ name: true, host: true, port: true, system_id: true, password: true, max_tps: true })
  .strict();
const httpCreateSchema = z
  .object({
    kind: z.literal('HTTP'),
    name: base.name,
    adapter: adapterId,
    credentials: credentialMap.default({}),
    settings: settingMap.default({}),
    max_tps: base.max_tps.optional(),
    enabled: base.enabled.optional(),
    notes: base.notes.optional(),
  })
  .strict();
const patchSchema = z
  .object({ ...base, kind: z.enum(CONNECTION_KINDS), adapter: adapterId, credentials: credentialMap, settings: settingMap })
  .partial()
  .strict();
const listSchema = paginationSchema.extend({
  q: z.string().trim().min(1).max(100).optional(),
  enabled: queryBool.optional(),
  kind: z.enum(CONNECTION_KINDS).optional(),
});
const testSchema = z
  .object({
    to: z.string().trim().regex(/^\+?[0-9][0-9 ()-]{4,19}$/, 'must be a phone number (digits, optional +)'),
    text: z.string().min(1, 'text is required').max(1600),
  })
  .strict();
const ratesSchema = z
  .array(z.object({ prefix: digitsPrefix.default(''), cost_micros: z.number().int().nonnegative().safe() }).strict())
  .max(10_000);

@Controller('api/connections')
@Roles('SUPER_ADMIN')
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}

  @Get()
  list(@Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    return this.connections.list(q);
  }

  @Post()
  create(@Body() body: unknown) {
    const isHttp = typeof body === 'object' && body !== null && (body as { kind?: unknown }).kind === 'HTTP';
    return this.connections.create(isHttp ? parseOrThrow(httpCreateSchema, body) : parseOrThrow(createSchema, body));
  }

  /** HTTP adapter catalogue (engine, cached 60s). Declared before `:id` routes. */
  @Get('adapters')
  @NoRequestTransaction()
  adapters() {
    return this.connections.adapters();
  }

  @Get(':id')
  get(@Param('id', UuidPipe) id: string) {
    return this.connections.get(id);
  }

  @Patch(':id')
  patch(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(patchSchema)) body: z.infer<typeof patchSchema>) {
    return this.connections.update(id, body);
  }

  /** Sends ONE real SMS through the connection (engine; outside billing/CDR). */
  @Post(':id/test')
  @HttpCode(200)
  @NoRequestTransaction()
  test(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(testSchema)) body: z.infer<typeof testSchema>) {
    return this.connections.test(id, body);
  }

  @Get(':id/balance')
  @NoRequestTransaction()
  balance(@Param('id', UuidPipe) id: string) {
    return this.connections.balance(id);
  }

  @Delete(':id')
  remove(@Param('id', UuidPipe) id: string) {
    return this.connections.remove(id);
  }

  @Get(':id/rates')
  rates(@Param('id', UuidPipe) id: string) {
    return this.connections.rates(id);
  }

  @Put(':id/rates')
  replaceRates(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(ratesSchema)) body: z.infer<typeof ratesSchema>) {
    return this.connections.replaceRates(id, body);
  }
}
