import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { orgIdQuery, scopedListQuery } from '../common/scoped-query';
import { UuidPipe } from '../common/uuid.pipe';
import { re2Pattern } from '../common/validation';
import { ZodPipe } from '../common/zod.pipe';
import { BlocklistService } from './blocklist.service';

const listSchema = scopedListQuery.extend({ q: z.string().trim().min(1).max(20).optional() });
const numberSchema = z.object({ prefix: z.string().trim().min(1).max(32), note: z.string().trim().max(500).nullable().optional() }).strict();
const keywordSchema = z.object({ pattern: re2Pattern, note: z.string().trim().max(500).nullable().optional() }).strict();

@Controller('api/blocklist')
export class BlocklistController {
  constructor(private readonly blocklist: BlocklistService) {}

  @Get('numbers')
  numbers(@Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    return this.blocklist.list('numbers', q);
  }

  @Post('numbers')
  addNumber(@Query(new ZodPipe(orgIdQuery)) q: z.infer<typeof orgIdQuery>, @Body(new ZodPipe(numberSchema)) body: z.infer<typeof numberSchema>) {
    return this.blocklist.addNumber(q.org_id, body);
  }

  @Delete('numbers/:id')
  removeNumber(@Param('id', UuidPipe) id: string) {
    return this.blocklist.remove('numbers', id);
  }

  @Get('keywords')
  keywords(@Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    return this.blocklist.list('keywords', q);
  }

  @Post('keywords')
  addKeyword(@Query(new ZodPipe(orgIdQuery)) q: z.infer<typeof orgIdQuery>, @Body(new ZodPipe(keywordSchema)) body: z.infer<typeof keywordSchema>) {
    return this.blocklist.addKeyword(q.org_id, body);
  }

  @Delete('keywords/:id')
  removeKeyword(@Param('id', UuidPipe) id: string) {
    return this.blocklist.remove('keywords', id);
  }
}
