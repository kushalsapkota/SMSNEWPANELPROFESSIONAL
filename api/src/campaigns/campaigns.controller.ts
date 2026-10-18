import { Body, Controller, Get, HttpCode, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { NoRequestTransaction, Roles } from '../common/decorators';
import { AppError } from '../common/errors';
import { paginationSchema } from '../common/pagination';
import { UuidPipe } from '../common/uuid.pipe';
import { senderAddress, uuid } from '../common/validation';
import { parseOrThrow, ZodPipe } from '../common/zod.pipe';
import { CAMPAIGN_STATUSES } from '../db/types';
import { CampaignsService } from './campaigns.service';
import { MAX_CAMPAIGN_RECIPIENTS, parseRecipientsCsv, parseRecipientsJson } from './recipients';

/** Multipart fields arrive as strings; "" means absent. */
const emptyToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v);
const fields = {
  name: z.string().trim().min(1).max(200),
  source_addr: senderAddress,
  body: z.string().min(1).max(5000),
  scheduled_at: z.preprocess(emptyToUndefined, z.string().datetime({ offset: true }).nullable().optional()),
};
const multipartSchema = z.object(fields);
const jsonSchema = z
  .object({
    ...fields,
    recipients: z
      .array(z.record(z.union([z.string(), z.number(), z.null()])))
      .min(1)
      .max(MAX_CAMPAIGN_RECIPIENTS * 2),
  })
  .strict();

const listSchema = paginationSchema.extend({ org_id: uuid.optional(), status: z.enum(CAMPAIGN_STATUSES).optional() });
const recipientsSchema = paginationSchema.extend({ state: z.enum(['pending', 'submitted', 'failed']).optional() });

/** The parts of multer's memory-storage file we use. */
interface UploadedCsv {
  buffer: Buffer;
  originalname: string;
  size: number;
}

/** 100k rows of phone + a few variables stays far below this. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

@ApiTags('campaigns')
@Controller('api/campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  /**
   * multipart/form-data: `file` (CSV with a "phone" column) + name, source_addr, body, scheduled_at?
   * application/json:    {name, source_addr, body, recipients:[{phone, ...vars}], scheduled_at?}
   */
  @Post()
  @Roles('RESELLER', 'CLIENT')
  // The upload streams in before the handler runs: don't hold a DB transaction open for it.
  @NoRequestTransaction()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 20 } }))
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'source_addr', 'body'],
      properties: {
        file: { type: 'string', format: 'binary', description: 'CSV with a header row including "phone"; other columns become {column} placeholders' },
        name: { type: 'string' },
        source_addr: { type: 'string' },
        body: { type: 'string', example: 'Hi {name}, your order {order} has shipped' },
        scheduled_at: { type: 'string', format: 'date-time', nullable: true },
        recipients: { type: 'array', items: { type: 'object', properties: { phone: { type: 'string' } }, additionalProperties: { type: 'string' } } },
      },
    },
  })
  create(@Body() body: unknown, @UploadedFile() file?: UploadedCsv) {
    if (file) {
      const input = parseOrThrow(multipartSchema, body);
      return this.campaigns.create(input, parseRecipientsCsv(file.buffer));
    }
    if (body && typeof body === 'object' && !('recipients' in body)) {
      throw AppError.invalid('Provide a CSV "file" (multipart) or a "recipients" array (JSON)', { field: 'file' });
    }
    const input = parseOrThrow(jsonSchema, body);
    return this.campaigns.create(input, parseRecipientsJson(input.recipients));
  }

  @Get()
  list(@Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    return this.campaigns.list(q);
  }

  @Get(':id')
  get(@Param('id', UuidPipe) id: string) {
    return this.campaigns.get(id);
  }

  @Get(':id/recipients')
  recipients(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(recipientsSchema)) q: z.infer<typeof recipientsSchema>) {
    return this.campaigns.recipients(id, q);
  }

  @Post(':id/start')
  @HttpCode(200)
  start(@Param('id', UuidPipe) id: string) {
    return this.campaigns.transition(id, 'start');
  }

  @Post(':id/pause')
  @HttpCode(200)
  pause(@Param('id', UuidPipe) id: string) {
    return this.campaigns.transition(id, 'pause');
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id', UuidPipe) id: string) {
    return this.campaigns.transition(id, 'cancel');
  }
}
