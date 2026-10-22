import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { Roles } from '../common/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { DomainsService } from './domains.service';

// One DNS hostname, lowercased. The agent validates again before touching nginx/certbot.
const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?!-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.(?!-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/,
    'must be a valid domain name',
  )
  .regex(/\.[a-z]{2,}$/, 'must end in a valid TLD');

const addSchema = z
  .object({
    domain: domainSchema,
    role: z.enum(['panel', 'smpp', 'both']),
  })
  .strict();

@Controller('api/domains')
@Roles('SUPER_ADMIN')
export class DomainsController {
  constructor(
    private readonly domains: DomainsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  status() {
    return this.domains.status();
  }

  /** Issue the cert, write the managed vhost, validate + reload nginx (rolls back on failure). */
  @Post()
  @HttpCode(200)
  async add(@Body(new ZodPipe(addSchema)) body: z.infer<typeof addSchema>) {
    const result = await this.domains.add(body);
    await this.audit.record({
      action: 'domains.add',
      entityType: 'domain',
      entityId: body.domain,
      after: { domain: body.domain, role: body.role },
    });
    return result;
  }

  /** Remove the managed vhost + reload nginx. The issued cert is left on disk. */
  @Delete(':domain')
  @HttpCode(200)
  async remove(@Param('domain', new ZodPipe(domainSchema)) domain: string) {
    const result = await this.domains.remove(domain);
    await this.audit.record({ action: 'domains.remove', entityType: 'domain', entityId: domain, before: { domain } });
    return result;
  }
}
