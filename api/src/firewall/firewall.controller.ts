import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { Roles } from '../common/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { FirewallService } from './firewall.service';

// A source is a single IPv4/IPv6 address or CIDR; the agent validates it again before applying.
const cidr = z
  .string()
  .trim()
  .max(43)
  .regex(/^(\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?|[0-9a-fA-F:]+(\/\d{1,3})?)$/, 'must be an IP or CIDR');

const ruleSchema = z
  .object({
    action: z.enum(['allow', 'deny']),
    proto: z.enum(['tcp', 'udp', 'any']).default('tcp'),
    port: z.number().int().min(1).max(65535).nullable().default(null),
    source: cidr.nullable().default(null),
  })
  .strict();

const applySchema = z
  .object({
    enabled: z.boolean(),
    default_policy: z.enum(['allow', 'deny']),
    rules: z.array(ruleSchema).max(200),
  })
  .strict();

@Controller('api/firewall')
@Roles('SUPER_ADMIN')
export class FirewallController {
  constructor(
    private readonly fw: FirewallService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  status() {
    return this.fw.status();
  }

  /** Stage a ruleset. It auto-reverts after the agent's window unless /commit is called. */
  @Put()
  @HttpCode(200)
  async apply(@Body(new ZodPipe(applySchema)) body: z.infer<typeof applySchema>) {
    const result = await this.fw.apply(body);
    await this.audit.record({
      action: 'firewall.apply',
      entityType: 'firewall',
      after: { enabled: body.enabled, default_policy: body.default_policy, rule_count: body.rules.length },
    });
    return result;
  }

  @Post('commit')
  @HttpCode(200)
  async commit() {
    const result = await this.fw.commit();
    await this.audit.record({ action: 'firewall.commit', entityType: 'firewall' });
    return result;
  }

  @Post('revert')
  @HttpCode(200)
  async revert() {
    const result = await this.fw.revert();
    await this.audit.record({ action: 'firewall.revert', entityType: 'firewall' });
    return result;
  }
}
