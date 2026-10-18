import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { Roles } from '../common/decorators';
import { paginationSchema } from '../common/pagination';
import { UuidPipe } from '../common/uuid.pipe';
import { digitsPrefix, hostOrIp, queryBool, senderAddress, uuid } from '../common/validation';
import { ZodPipe } from '../common/zod.pipe';
import { BIND_TYPES, MULTIPART_MODES, TEMPLATE_FALLBACKS } from '../db/types';
import { adapterId, credentialMap, settingMap } from '../connections/http-adapters';
import { AssignmentsService } from './assignments.service';
import { QuickConnectionInput, QuickRouteService } from './quick-route.service';
import { RoutesService } from './routes.service';

const routeBase = {
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000).nullable(),
  enabled: z.boolean(),
  template_mode: z.boolean(),
  template_fallback: z.enum(TEMPLATE_FALLBACKS),
  force_sender_id: senderAddress.nullable(),
};
const createSchema = z.object(routeBase).partial().required({ name: true }).strict();
const patchSchema = z.object(routeBase).partial().strict();
const listSchema = paginationSchema.extend({ q: z.string().trim().min(1).max(100).optional(), enabled: queryBool.optional() });
const connectionsSchema = z
  .array(
    z
      .object({
        connection_id: uuid,
        priority: z.number().int().min(1).max(32767).default(1),
        weight: z.number().int().min(1).max(32767).default(100),
        enabled: z.boolean().default(true),
      })
      .strict(),
  )
  .max(64);
const priority = z.number().int().min(1).max(32767);
const weight = z.number().int().min(1).max(32767);
const quickExisting = z
  .object({ existing_connection_id: uuid, priority: priority.optional(), weight: weight.default(100) })
  .strict();
const quickSmpp = z
  .object({
    type: z.literal('SMPP'),
    name: z.string().trim().min(1).max(100).optional(),
    host: hostOrIp,
    port: z.number({ invalid_type_error: 'port must be a number' }).int().min(1, 'port must be 1-65535').max(65535, 'port must be 1-65535'),
    system_id: z.string().min(1, 'username (system_id) is required').max(15, 'username (system_id) is at most 15 characters (SMPP 3.4)'),
    password: z.string().min(1, 'password is required').max(8, 'SMPP 3.4 passwords are at most 8 characters'),
    system_type: z.string().max(12).optional(),
    bind_type: z.enum(BIND_TYPES).default('TRX'),
    use_tls: z.boolean().default(false),
    max_tps: z.number().int().positive().max(1_000_000).default(50),
    sessions: z.number().int().min(1).max(64).default(1),
    window_size: z.number().int().min(1).max(1000).optional(),
    enquire_link_interval_s: z.number().int().min(1).max(3600).optional(),
    multipart_mode: z.enum(MULTIPART_MODES).optional(),
    request_dlr: z.boolean().default(true),
    priority: priority.optional(),
    weight: weight.default(100),
    cost_micros: z.number().int().nonnegative().safe().optional(),
  })
  .strict();
/** New HTTP API connection: adapter + credentials (+ settings), checked against the engine catalogue in the service. */
const quickHttp = z
  .object({
    type: z.literal('HTTP'),
    name: z.string().trim().min(1).max(100).optional(),
    adapter: adapterId,
    credentials: credentialMap.default({}),
    settings: settingMap.optional(),
    max_tps: z.number().int().positive().max(1_000_000).optional(),
    priority: priority.optional(),
    weight: weight.default(100),
    cost_micros: z.number().int().nonnegative().safe().optional(),
  })
  .strict();
/** `{existing_connection_id}`, `{type: "SMPP", ...}` or `{type: "HTTP", ...}`; errors are reported against the matching shape. */
const quickConnection = z.unknown().transform((v, ctx): QuickConnectionInput => {
  const isObj = typeof v === 'object' && v !== null;
  if (isObj && 'existing_connection_id' in v) return parseInto(quickExisting, v, ctx);
  const t = isObj ? (v as { type?: unknown }).type : undefined;
  if (t === 'HTTP') return parseInto(quickHttp, v, ctx);
  if (isObj && t !== 'SMPP') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['type'], message: 'type must be "SMPP" or "HTTP" (or pass existing_connection_id)' });
    return z.NEVER;
  }
  return parseInto(quickSmpp, v, ctx);
});
function parseInto<S extends z.ZodTypeAny>(schema: S, v: unknown, ctx: z.RefinementCtx): z.output<S> {
  const r = schema.safeParse(v);
  if (r.success) return r.data;
  for (const issue of r.error.issues) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue.message, path: issue.path });
  return z.NEVER;
}
const quickSchema = z
  .object({
    ...routeBase,
    description: routeBase.description.optional(),
    enabled: z.boolean().default(true),
    template_mode: z.boolean().default(false),
    template_fallback: routeBase.template_fallback.optional(),
    force_sender_id: routeBase.force_sender_id.optional(),
    template_body: z.string().min(1).max(1600).optional(),
    default_body: z.string().min(1).max(1600).nullable().optional(),
    connections: z.array(quickConnection).min(1, 'add at least one connection').max(10, 'at most 10 connections'),
  })
  .strict();

const assignmentsSchema = z
  .array(
    z
      .object({
        route_id: uuid,
        prefix: digitsPrefix.default(''),
        rate_micros: z.number().int().nonnegative().safe(),
        priority: z.number().int().min(1).max(32767).default(1),
        enabled: z.boolean().default(true),
      })
      .strict(),
  )
  .max(1000);

@Controller('api/routes')
export class RoutesController {
  constructor(
    private readonly routes: RoutesService,
    private readonly quick: QuickRouteService,
  ) {}

  @Get()
  list(@Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    return this.routes.list(q);
  }

  @Post()
  @Roles('SUPER_ADMIN')
  create(@Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>) {
    return this.routes.create(body);
  }

  /** One-step route creation with inline SMPP connections (CONTRACTS-CHANGES: quick route). */
  @Post('quick')
  @Roles('SUPER_ADMIN')
  createQuick(@Body(new ZodPipe(quickSchema)) body: z.infer<typeof quickSchema>) {
    return this.quick.create(body);
  }

  @Get(':id/status')
  @Roles('SUPER_ADMIN')
  status(@Param('id', UuidPipe) id: string) {
    return this.quick.status(id);
  }

  @Get(':id')
  @Roles('SUPER_ADMIN')
  get(@Param('id', UuidPipe) id: string) {
    return this.routes.get(id);
  }

  @Patch(':id')
  @Roles('SUPER_ADMIN')
  patch(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(patchSchema)) body: z.infer<typeof patchSchema>) {
    return this.routes.update(id, body);
  }

  @Delete(':id')
  @Roles('SUPER_ADMIN')
  remove(@Param('id', UuidPipe) id: string) {
    return this.routes.remove(id);
  }

  @Put(':id/connections')
  @Roles('SUPER_ADMIN')
  connections(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(connectionsSchema)) body: z.infer<typeof connectionsSchema>) {
    return this.routes.replaceConnections(id, body);
  }
}

@Controller('api/orgs/:id/routes')
export class OrgRoutesController {
  constructor(private readonly assignments: AssignmentsService) {}

  @Get()
  list(@Param('id', UuidPipe) id: string) {
    return this.assignments.list(id);
  }

  @Put()
  replace(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(assignmentsSchema)) body: z.infer<typeof assignmentsSchema>) {
    return this.assignments.replace(id, body);
  }
}
