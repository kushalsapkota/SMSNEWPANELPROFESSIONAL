import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { Roles } from '../common/decorators';
import { paginationSchema } from '../common/pagination';
import { UuidPipe } from '../common/uuid.pipe';
import { digitsPrefix, queryBool, senderAddress, uuid } from '../common/validation';
import { ZodPipe } from '../common/zod.pipe';
import { TEMPLATE_FALLBACKS } from '../db/types';
import { AssignmentsService } from './assignments.service';
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
  constructor(private readonly routes: RoutesService) {}

  @Get()
  list(@Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    return this.routes.list(q);
  }

  @Post()
  @Roles('SUPER_ADMIN')
  create(@Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>) {
    return this.routes.create(body);
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
