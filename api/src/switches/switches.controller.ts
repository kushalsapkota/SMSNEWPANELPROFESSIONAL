import { Body, Controller, Get, HttpCode, Put } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { Roles } from '../common/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { SwitchesService } from './switches.service';

// Every switch is optional: a PUT changes only the keys it sends, so the UI can
// flip one toggle (or all of them, via the master) without resending the rest.
const updateSchema = z
  .object({
    all_enabled: z.boolean().optional(),
    http_api_enabled: z.boolean().optional(),
    smpp_enabled: z.boolean().optional(),
    bulk_enabled: z.boolean().optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, 'at least one field is required');

@Controller('api/switches')
@Roles('SUPER_ADMIN')
export class SwitchesController {
  constructor(
    private readonly switches: SwitchesService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  status() {
    return this.switches.status();
  }

  @Put()
  @HttpCode(200)
  async update(@Body(new ZodPipe(updateSchema)) body: z.infer<typeof updateSchema>) {
    const before = await this.switches.status();
    const after = await this.switches.update(body);
    await this.audit.record({
      action: 'switches.update',
      entityType: 'service_switches',
      before: {
        all_enabled: before.all_enabled,
        http_api_enabled: before.http_api_enabled,
        smpp_enabled: before.smpp_enabled,
        bulk_enabled: before.bulk_enabled,
      },
      after: {
        all_enabled: after.all_enabled,
        http_api_enabled: after.http_api_enabled,
        smpp_enabled: after.smpp_enabled,
        bulk_enabled: after.bulk_enabled,
      },
    });
    return after;
  }
}
