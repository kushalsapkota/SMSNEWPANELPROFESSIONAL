import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { NoRequestTransaction } from '../common/decorators';
import { paginationSchema } from '../common/pagination';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe, parseOrThrow } from '../common/zod.pipe';
import { BILLING_MODES, LEDGER_TYPES } from '../db/types';
import { BalanceService } from './balance.service';

const maxAmount = 1_000_000_000_000_000; // 1e9 currency units in micros
const idemKey = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.:-]+$/, 'invalid characters');
const topupSchema = z
  .object({
    amount_micros: z.number().int().positive().max(maxAmount),
    note: z.string().trim().max(500).optional(),
    reference: z.string().trim().max(200).optional(),
    idempotency_key: idemKey.optional(),
  })
  .strict();
const adjustSchema = z
  .object({
    amount_micros: z.number().int().min(-maxAmount).max(maxAmount).refine((v) => v !== 0, 'must not be 0'),
    note: z.string().trim().min(1).max(500),
    reference: z.string().trim().max(200).optional(),
    idempotency_key: idemKey.optional(),
  })
  .strict();
const billingSchema = z
  .object({
    billing_mode: z.enum(BILLING_MODES).optional(),
    credit_limit_micros: z.number().int().nonnegative().max(maxAmount).optional(),
    low_balance_alert_micros: z.number().int().nonnegative().max(maxAmount).nullable().optional(),
  })
  .strict();
const txListSchema = paginationSchema.extend({ type: z.enum(LEDGER_TYPES).optional() });

@Controller('api/orgs/:id')
export class BalanceController {
  constructor(private readonly balance: BalanceService) {}

  @Get('balance')
  get(@Param('id', UuidPipe) id: string) {
    return this.balance.get(id);
  }

  /** Idempotency: body.idempotency_key or the Idempotency-Key header. */
  @Post('balance/topup')
  @HttpCode(200)
  @NoRequestTransaction()
  topup(@Param('id', UuidPipe) id: string, @Body() body: unknown, @Headers('idempotency-key') header?: string) {
    const input = parseOrThrow(topupSchema, body);
    return this.balance.topup(id, { ...input, idempotency_key: input.idempotency_key ?? parseOrThrow(idemKey.optional(), header) });
  }

  @Post('balance/adjust')
  @HttpCode(200)
  @NoRequestTransaction()
  adjust(@Param('id', UuidPipe) id: string, @Body() body: unknown, @Headers('idempotency-key') header?: string) {
    const input = parseOrThrow(adjustSchema, body);
    return this.balance.adjust(id, { ...input, idempotency_key: input.idempotency_key ?? parseOrThrow(idemKey.optional(), header) });
  }

  @Patch('billing')
  billing(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(billingSchema)) body: z.infer<typeof billingSchema>) {
    return this.balance.patchBilling(id, body);
  }

  @Get('transactions')
  transactions(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(txListSchema)) q: z.infer<typeof txListSchema>) {
    return this.balance.transactions(id, q);
  }
}
