import { Body, Controller, Get, Injectable, Module, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { currentAuth } from '../common/context';
import { NoRequestTransaction, Roles } from '../common/decorators';
import { AppError } from '../common/errors';
import { UuidPipe } from '../common/uuid.pipe';
import { senderAddress, uuid } from '../common/validation';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.service';
import { EngineClient } from '../engine/engine-client.service';
import { messageDto } from '../messages/message.dto';
import { MessagesModule } from '../messages/messages.module';
import { MessagesService } from '../messages/messages.service';
import { normalizeDestination } from '../messaging/msisdn';

const sendSchema = z
  .object({
    route_id: uuid,
    destination: z.string().trim().min(1).max(32),
    text: z.string().min(1).max(5000),
    source: senderAddress,
  })
  .strict();

const msBetween = (a: Date | null, b: Date | null): number | null => (a && b ? Math.max(0, b.getTime() - a.getTime()) : null);

/** Timings from the CDR: accepted = created_at; submit latency = submitted - accepted; DLR latency = dlr - submitted. */
export function testerTimings(m: { created_at: Date; submitted_at: Date | null; dlr_received_at: Date | null }) {
  return {
    accepted_at: m.created_at,
    submitted_at: m.submitted_at,
    dlr_received_at: m.dlr_received_at,
    submit_latency_ms: msBetween(m.created_at, m.submitted_at),
    dlr_latency_ms: msBetween(m.submitted_at, m.dlr_received_at),
    total_latency_ms: msBetween(m.created_at, m.dlr_received_at),
  };
}

@Injectable()
export class TesterService {
  constructor(
    private readonly db: DbService,
    private readonly engine: EngineClient,
    private readonly audit: AuditService,
    private readonly messages: MessagesService,
  ) {}

  /**
   * Forced-route test send (CONTRACTS §5 `test: true`, `route_id`). The route must be visible
   * to the caller (admin: any; reseller: assigned to it or its clients). SUPER_ADMIN sends are
   * unbilled by the engine; a reseller's test is billed like any send.
   */
  async send(input: z.infer<typeof sendSchema>) {
    const auth = currentAuth();
    const dest = normalizeDestination(input.destination);
    if (!dest) throw new AppError('INVALID_DESTINATION', `Invalid destination number: ${input.destination}`, { field: 'destination' });
    const route = await this.db.tenant((trx) => trx.selectFrom('routes').select(['id', 'name']).where('id', '=', input.route_id).executeTakeFirst());
    if (!route) throw AppError.notFound('Route');

    const result = await this.engine.submit({
      org_id: auth.orgId,
      channel: 'WEB',
      source: input.source,
      destination: dest,
      text: input.text,
      route_id: input.route_id,
      test: true,
    });
    await this.db.tenant(() =>
      this.audit.record({
        action: 'tester.send',
        entityType: 'message',
        entityId: result.message_id,
        targetOrgId: auth.orgId,
        after: { route_id: input.route_id, route_name: route.name, destination: dest, source: input.source, parts: result.parts, cost_micros: result.cost_micros },
      }),
    );
    return result;
  }

  async get(id: string) {
    const row = await this.messages.findVisible(id);
    if (!row) throw AppError.notFound('Message');
    return { message: messageDto(row, currentAuth().role), timings: testerTimings(row) };
  }
}

@ApiTags('tester')
@Controller('api/tester')
@Roles('SUPER_ADMIN', 'RESELLER')
export class TesterController {
  constructor(private readonly tester: TesterService) {}

  @Post('send')
  @NoRequestTransaction()
  send(@Body(new ZodPipe(sendSchema)) body: z.infer<typeof sendSchema>) {
    return this.tester.send(body);
  }

  @Get(':message_id')
  get(@Param('message_id', UuidPipe) id: string) {
    return this.tester.get(id);
  }
}

@Module({ imports: [MessagesModule], controllers: [TesterController], providers: [TesterService] })
export class TesterModule {}
