import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { paginationSchema } from '../common/pagination';
import { UuidPipe } from '../common/uuid.pipe';
import { re2Pattern, uuid } from '../common/validation';
import { ZodPipe } from '../common/zod.pipe';
import { TEMPLATE_FALLBACKS } from '../db/types';
import { TemplatesService } from './templates.service';

const body = {
  name: z.string().trim().min(1).max(100),
  extract_patterns: z.array(re2Pattern).min(1).max(10),
  otp_min_len: z.number().int().min(1).max(32),
  otp_max_len: z.number().int().min(1).max(32),
  template_body: z.string().min(1).max(1600),
  default_body: z.string().min(1).max(1600).nullable(),
  fallback_action: z.enum(TEMPLATE_FALLBACKS).nullable(),
  brand: z.string().trim().max(100).nullable(),
  is_active: z.boolean(),
};
const createSchema = z
  .object({ route_id: uuid, org_id: uuid.nullable().optional(), ...body })
  .partial({ extract_patterns: true, otp_min_len: true, otp_max_len: true, default_body: true, fallback_action: true, brand: true, is_active: true })
  .strict();
const patchSchema = z.object(body).partial().strict();
const listSchema = paginationSchema.extend({ route_id: uuid.optional(), org_id: uuid.optional() });
const previewSchema = z
  .object({
    text: z.string().min(1).max(1600),
    route_id: uuid.optional(),
    org_id: uuid.optional(),
    template: z
      .object({
        extract_patterns: z.array(re2Pattern).min(1).max(10),
        otp_min_len: z.number().int().min(1).max(32).default(4),
        otp_max_len: z.number().int().min(1).max(32).default(8),
        template_body: z.string().min(1).max(1600),
        default_body: z.string().max(1600).nullable().default(null),
        fallback_action: z.enum(TEMPLATE_FALLBACKS).nullable().default(null),
        brand: z.string().max(100).nullable().default(null),
      })
      .strict()
      .optional(),
  })
  .strict();

@Controller('api/templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  list(@Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    return this.templates.list(q);
  }

  @Post('preview')
  @HttpCode(200)
  preview(@Body(new ZodPipe(previewSchema)) b: z.infer<typeof previewSchema>) {
    return this.templates.preview(b);
  }

  @Post()
  create(@Body(new ZodPipe(createSchema)) b: z.infer<typeof createSchema>) {
    return this.templates.create(b);
  }

  @Get(':id')
  get(@Param('id', UuidPipe) id: string) {
    return this.templates.get(id);
  }

  @Patch(':id')
  patch(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(patchSchema)) b: z.infer<typeof patchSchema>) {
    return this.templates.update(id, b);
  }

  @Delete(':id')
  remove(@Param('id', UuidPipe) id: string) {
    return this.templates.remove(id);
  }
}
