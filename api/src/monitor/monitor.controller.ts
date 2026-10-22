import { Controller, Get } from '@nestjs/common';
import { currentAuth } from '../common/context';
import { Roles } from '../common/decorators';
import { DbService } from '../db/db.service';
import { EngineClient } from '../engine/engine-client.service';
import { isUuid } from '../tenancy/scope.service';
import { GeoIpService } from './geoip.service';

@Controller('api/monitor')
export class MonitorController {
  constructor(
    private readonly engine: EngineClient,
    private readonly db: DbService,
    private readonly geo: GeoIpService,
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
    const shaped =
      auth.role === 'SUPER_ADMIN'
        ? sessions.map((s) => ({ ...s, org_name: names.get(s.org_id) ?? null }))
        : sessions.filter((s) => names.has(s.org_id)).map((s) => ({ ...s, org_name: names.get(s.org_id) ?? null }));
    // Enrich each bind IP with a coarse location (cached; private IPs and failures → null).
    const geo = await this.geo.locate(shaped.map((s) => s.remote_addr));
    return { sessions: shaped.map((s) => ({ ...s, location: geo.get(s.remote_addr) ?? null })) };
  }

  /**
   * Recent SMPP bind events (accepted / rejected with reason / unbound), newest first.
   * Admin: all. Reseller/client: only events for orgs they can see. Rejections with an unknown
   * system_id (no org) are admin-only.
   */
  @Get('smpp-events')
  async smppEvents() {
    const auth = currentAuth();
    const events = await this.engine.smppEvents(1000);
    const orgIds = [...new Set(events.map((e) => e.org_id).filter(isUuid))];
    const visible = orgIds.length === 0 ? [] : await this.db.tenant((trx) => trx.selectFrom('organizations').select(['id', 'name']).where('id', 'in', orgIds).execute());
    const names = new Map(visible.map((o) => [o.id, o.name]));
    if (auth.role === 'SUPER_ADMIN') return { events: events.map((e) => ({ ...e, org_name: isUuid(e.org_id) ? names.get(e.org_id) ?? null : null })) };
    // Non-admin: only events for orgs the caller can see (RLS filtered the name lookup).
    return { events: events.filter((e) => isUuid(e.org_id) && names.has(e.org_id)).map((e) => ({ ...e, org_name: names.get(e.org_id) ?? null })) };
  }
}
