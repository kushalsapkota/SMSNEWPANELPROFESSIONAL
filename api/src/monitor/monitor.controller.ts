import { Controller, Get } from '@nestjs/common';
import { currentAuth } from '../common/context';
import { Roles } from '../common/decorators';
import { DbService } from '../db/db.service';
import { EngineClient } from '../engine/engine-client.service';
import { isUuid } from '../tenancy/scope.service';

@Controller('api/monitor')
export class MonitorController {
  constructor(
    private readonly engine: EngineClient,
    private readonly db: DbService,
  ) {}

  @Get('connections')
  @Roles('SUPER_ADMIN')
  async connections() {
    return { connections: await this.engine.connectionsStatus() };
  }

  /** Admin: all sessions; reseller: its own + its clients'; client: its own. */
  @Get('smpp-sessions')
  async smppSessions() {
    const auth = currentAuth();
    const sessions = await this.engine.smppSessions();
    const orgIds = [...new Set(sessions.map((s) => s.org_id).filter(isUuid))];
    // RLS limits this to the orgs the caller may see (admin: all; reseller: itself + clients; client: itself).
    const visible = orgIds.length === 0 ? [] : await this.db.tenant((trx) => trx.selectFrom('organizations').select(['id', 'name']).where('id', 'in', orgIds).execute());
    const names = new Map(visible.map((o) => [o.id, o.name]));
    if (auth.role === 'SUPER_ADMIN') return { sessions: sessions.map((s) => ({ ...s, org_name: names.get(s.org_id) ?? null })) };
    return { sessions: sessions.filter((s) => names.has(s.org_id)).map((s) => ({ ...s, org_name: names.get(s.org_id) })) };
  }
}
