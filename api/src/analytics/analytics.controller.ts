import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { NoRequestTransaction, Roles } from '../common/decorators';
import { uuid } from '../common/validation';
import { ZodPipe } from '../common/zod.pipe';
import { dateParam, resolveRange } from '../messaging/dates';
import { AnalyticsService } from './analytics.service';

const base = z.object({
  from: dateParam.optional(),
  to: dateParam.optional(),
  org_id: uuid.optional(),
  route_id: uuid.optional(),
});
const seriesQuery = base.extend({
  granularity: z.enum(['hour', 'day']).default('day'),
  tz: z.string().trim().min(1).max(64).optional(),
});
const breakdownQuery = base.extend({ by: z.enum(['route', 'country', 'org', 'status']) });

/** Default window: the last 7 days; at most 400 days. */
function range(q: z.infer<typeof base>) {
  return { ...resolveRange(q.from, q.to, 7, 400), org_id: q.org_id, route_id: q.route_id };
}

@ApiTags('analytics')
@Controller('api/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('summary')
  summary(@Query(new ZodPipe(base)) q: z.infer<typeof base>) {
    return this.analytics.summary(range(q));
  }

  @Get('timeseries')
  timeseries(@Query(new ZodPipe(seriesQuery)) q: z.infer<typeof seriesQuery>) {
    return this.analytics.timeseries({ ...range(q), granularity: q.granularity, tz: q.tz });
  }

  @Get('breakdown')
  breakdown(@Query(new ZodPipe(breakdownQuery)) q: z.infer<typeof breakdownQuery>) {
    return this.analytics.breakdown({ ...range(q), by: q.by });
  }

  /** Per-client billing/usage table (volume + amount charged) over a date range. */
  @Get('clients')
  clients(@Query(new ZodPipe(base)) q: z.infer<typeof base>) {
    return this.analytics.clients(range(q));
  }

  /** Engine calls only (no DB): no request transaction. */
  @Get('live')
  @Roles('SUPER_ADMIN')
  @NoRequestTransaction()
  live() {
    return this.analytics.live();
  }
}
