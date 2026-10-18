import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { NoRequestTransaction, Public } from '../common/decorators';
import { UuidPipe } from '../common/uuid.pipe';
import { senderAddress } from '../common/validation';
import { ZodPipe } from '../common/zod.pipe';
import { MAX_RECIPIENTS } from '../messaging/send.service';
import { ApiKeyGuard, RequireScope } from './api-key.guard';
import { PublicApiService } from './public-api.service';
import { ERROR_SCHEMA, MESSAGE_STATUS_SCHEMA, SEND_BODY_SCHEMA, SEND_RESPONSE_SCHEMA } from './public-api.schemas';

const toField = z.union([z.string().trim().min(1).max(20_000), z.array(z.string().trim().min(1).max(32)).min(1).max(MAX_RECIPIENTS)]);
const sendSchema = z.object({
  to: toField,
  from: senderAddress,
  text: z.string().min(1).max(5000),
  client_ref: z.string().trim().min(1).max(64).optional(),
});
/** Legacy GET: same fields as query parameters (api_key is consumed by the guard). */
const legacySendSchema = z.object({
  to: z.string().trim().min(1).max(20_000),
  from: senderAddress,
  text: z.string().min(1).max(5000),
  client_ref: z.string().trim().min(1).max(64).optional(),
});

@ApiTags('public API (v1)')
@ApiSecurity('bearer-api-key')
@ApiSecurity('x-api-key')
@Public()
@UseGuards(ApiKeyGuard)
@Controller('v1')
export class PublicApiController {
  constructor(private readonly api: PublicApiService) {}

  @Post('sms/send')
  @HttpCode(200)
  @RequireScope('sms:send')
  @NoRequestTransaction()
  @ApiOperation({ summary: 'Send SMS to one or up to 1000 recipients', description: 'A single recipient that is rejected returns the 4xx/422 error body; with several recipients every row carries its own result.' })
  @ApiBody({ schema: SEND_BODY_SCHEMA })
  @ApiOkResponse({ schema: SEND_RESPONSE_SCHEMA })
  @ApiResponse({ status: 422, description: 'Rejected (single recipient)', schema: ERROR_SCHEMA })
  send(@Body(new ZodPipe(sendSchema)) body: z.infer<typeof sendSchema>) {
    return this.api.send(body);
  }

  @Get('sms/send')
  @RequireScope('sms:send')
  @NoRequestTransaction()
  @ApiOperation({ summary: 'Send SMS (legacy GET; api_key may be passed as a query parameter)' })
  @ApiQuery({ name: 'api_key', required: false })
  @ApiQuery({ name: 'to', description: 'Destination; several separated by commas' })
  @ApiQuery({ name: 'from' })
  @ApiQuery({ name: 'text' })
  @ApiQuery({ name: 'client_ref', required: false })
  @ApiOkResponse({ schema: SEND_RESPONSE_SCHEMA })
  sendLegacy(@Query(new ZodPipe(legacySendSchema)) q: z.infer<typeof legacySendSchema>) {
    return this.api.send(q);
  }

  @Get('sms/:message_id')
  @RequireScope('sms:read')
  @ApiOperation({ summary: 'Message status and delivery report' })
  @ApiParam({ name: 'message_id', format: 'uuid' })
  @ApiOkResponse({ schema: MESSAGE_STATUS_SCHEMA })
  message(@Param('message_id', UuidPipe) id: string) {
    return this.api.message(id);
  }

  @Get('balance')
  @RequireScope('balance:read', 'sms:send')
  @ApiOperation({ summary: 'Current balance (micros: 1 currency unit = 1,000,000)' })
  @ApiHeader({ name: 'X-API-Key', required: false })
  @ApiOkResponse({ schema: { type: 'object', properties: { balance_micros: { type: 'integer' }, currency: { type: 'string', example: 'USD' } } } })
  balance() {
    return this.api.balance();
  }
}
