import { CryptoService } from '../src/crypto/crypto.service';
import { loadConfig } from '../src/config/config';
import { Session, TestCtx, adminLogin, as, createChild, setup, uniq, waitFor } from './helpers';

describe('connections, routes & assignments', () => {
  let ctx: TestCtx;
  let admin: Session;
  let reseller: Session;
  let other: Session;
  let client: Session;
  let connId: string;
  let routeA: string;
  let routeB: string;
  let routeC: string;

  beforeAll(async () => {
    ctx = await setup();
    admin = await adminLogin(ctx);
    reseller = await createChild(ctx, admin, uniq('rt-r'));
    other = await createChild(ctx, admin, uniq('rt-o'));
    client = await createChild(ctx, reseller, uniq('rt-c'));
  });
  afterAll(async () => {
    await ctx.close();
  });

  describe('connections (admin only)', () => {
    it('creates a connection; password is encrypted (v1:) and never returned', async () => {
      const res = await as(ctx, admin).post('/api/connections', {
        name: uniq('carrier'),
        host: 'smpp.example.net',
        port: 2775,
        system_id: 'acme',
        password: 's3cr3t!',
        max_tps: 100,
        sessions: 2,
      });
      expect(res.status).toBe(201);
      connId = res.body.id;
      expect(res.body.password).toBeUndefined();
      expect(res.body.password_enc).toBeUndefined();
      expect(res.body.has_password).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain('s3cr3t');

      const row = await ctx.db.selectFrom('upstream_connections').select('password_enc').where('id', '=', connId).executeTakeFirstOrThrow();
      expect(row.password_enc).toMatch(/^v1:[A-Za-z0-9+/=]+$/);
      expect(new CryptoService(loadConfig()).decrypt(row.password_enc as string)).toBe('s3cr3t!');

      for (const r of [await as(ctx, admin).get(`/api/connections/${connId}`), await as(ctx, admin).get('/api/connections')]) {
        expect(r.status).toBe(200);
        expect(JSON.stringify(r.body)).not.toMatch(/password_enc|s3cr3t|v1:/);
      }
      const patched = await as(ctx, admin).patch(`/api/connections/${connId}`, { password: 'n3w', max_tps: 50 });
      expect(patched.body.max_tps).toBe(50);
      expect(JSON.stringify(patched.body)).not.toMatch(/password_enc|n3w/);
      const row2 = await ctx.db.selectFrom('upstream_connections').select('password_enc').where('id', '=', connId).executeTakeFirstOrThrow();
      expect(new CryptoService(loadConfig()).decrypt(row2.password_enc as string)).toBe('n3w');
      const audits = await ctx.db.selectFrom('audit_logs').select(['before', 'after']).where('entity_id', '=', connId).execute();
      expect(JSON.stringify(audits)).not.toMatch(/s3cr3t|n3w|password_enc|v1:/);
      await waitFor(() => ctx.invalidations.some((m) => m.entity === 'upstream_connections' && m.id === connId));
    });

    it('validates SMPP limits and rejects non-admins', async () => {
      const long = await as(ctx, admin).post('/api/connections', { name: uniq('x'), host: 'h', port: 1, system_id: 's', password: '123456789', max_tps: 1 });
      expect(long.status).toBe(400);
      expect(long.body.details.issues[0].path).toBe('password');
      expect((await as(ctx, reseller).get('/api/connections')).status).toBe(403);
      expect((await as(ctx, client).post('/api/connections', {})).status).toBe(403);
    });

    it('replaces the rate card', async () => {
      const put = await as(ctx, admin).put(`/api/connections/${connId}/rates`, [
        { prefix: '', cost_micros: 3000 },
        { prefix: '91', cost_micros: 1500 },
      ]);
      expect(put.status).toBe(200);
      expect(put.body.items.map((r: { prefix: string }) => r.prefix)).toEqual(['', '91']);
      const again = await as(ctx, admin).put(`/api/connections/${connId}/rates`, [{ prefix: '44', cost_micros: 2000 }]);
      expect(again.body.items).toHaveLength(1);
      expect((await as(ctx, admin).put(`/api/connections/${connId}/rates`, [{ prefix: '1', cost_micros: 1 }, { prefix: '1', cost_micros: 2 }])).status).toBe(400);
      expect((await as(ctx, admin).put(`/api/connections/${connId}/rates`, [{ prefix: '+1', cost_micros: 1 }])).status).toBe(400);
    });
  });

  describe('routes', () => {
    it('admin CRUD + connections', async () => {
      const a = await as(ctx, admin).post('/api/routes', { name: uniq('OTP'), template_mode: true, force_sender_id: 'VERIFY' });
      expect(a.status).toBe(201);
      routeA = a.body.id;
      routeB = (await as(ctx, admin).post('/api/routes', { name: uniq('Bulk') })).body.id;
      routeC = (await as(ctx, admin).post('/api/routes', { name: uniq('Secret') })).body.id;
      const dupe = await as(ctx, admin).post('/api/routes', { name: a.body.name });
      expect(dupe.status).toBe(409);

      const rc = await as(ctx, admin).put(`/api/routes/${routeA}/connections`, [{ connection_id: connId, priority: 1, weight: 50 }]);
      expect(rc.status).toBe(200);
      expect(rc.body.items[0]).toMatchObject({ connection_id: connId, priority: 1, weight: 50, enabled: true });
      expect((await as(ctx, admin).put(`/api/routes/${routeA}/connections`, [{ connection_id: '00000000-0000-4000-8000-000000000000' }])).status).toBe(400);

      const got = await as(ctx, admin).get(`/api/routes/${routeA}`);
      expect(got.body.connections).toHaveLength(1);
      const list = await as(ctx, admin).get('/api/routes?page_size=200');
      expect(list.body.items.find((r: { id: string }) => r.id === routeA)).toMatchObject({ connection_count: 1, enabled_connection_count: 1 });
      const patched = await as(ctx, admin).patch(`/api/routes/${routeB}`, { description: 'promo traffic', template_fallback: 'REJECT' });
      expect(patched.body).toMatchObject({ description: 'promo traffic', template_fallback: 'REJECT' });
      expect((await as(ctx, reseller).post('/api/routes', { name: 'x' })).status).toBe(403);
      expect((await as(ctx, reseller).get(`/api/routes/${routeA}`)).status).toBe(403);
      await waitFor(() => ctx.invalidations.some((m) => m.entity === 'route_connections'));
    });
  });

  describe('org route assignments', () => {
    it('admin assigns routes to a reseller; only the parent may do so', async () => {
      const put = await as(ctx, admin).put(`/api/orgs/${reseller.orgId}/routes`, [
        { route_id: routeA, prefix: '', rate_micros: 3000 },
        { route_id: routeA, prefix: '91', rate_micros: 2500 },
        { route_id: routeB, prefix: '44', rate_micros: 4000, priority: 2 },
      ]);
      expect(put.status).toBe(200);
      expect(put.body.items).toHaveLength(3);
      expect(put.body.items.every((i: { parent_rate_micros: unknown }) => i.parent_rate_micros === null)).toBe(true);
      expect((await as(ctx, reseller).put(`/api/orgs/${reseller.orgId}/routes`, [])).status).toBe(403);
      expect((await as(ctx, admin).put(`/api/orgs/${admin.orgId}/routes`, [])).status).toBe(403);
      const dup = await as(ctx, admin).put(`/api/orgs/${reseller.orgId}/routes`, [
        { route_id: routeA, prefix: '1', rate_micros: 1 },
        { route_id: routeA, prefix: '1', rate_micros: 2 },
      ]);
      expect(dup.status).toBe(400);
      await waitFor(() => ctx.invalidations.some((m) => m.entity === 'org_route_assignments'));
    });

    it('non-admin GET /api/routes returns assigned routes only (id, name, template_mode)', async () => {
      const r = await as(ctx, reseller).get('/api/routes');
      expect(r.status).toBe(200);
      expect(r.body.items.map((x: { id: string }) => x.id).sort()).toEqual([routeA, routeB].sort());
      expect(Object.keys(r.body.items[0]).sort()).toEqual(['id', 'name', 'template_mode']);
      expect((await as(ctx, other).get('/api/routes')).body.items).toEqual([]);
      expect((await as(ctx, client).get('/api/routes')).body.items).toEqual([]);
    });

    it('reseller assigns its own routes to a client; parent rate is shown to the reseller', async () => {
      const put = await as(ctx, reseller).put(`/api/orgs/${client.orgId}/routes`, [
        { route_id: routeA, prefix: '9198', rate_micros: 5000 },
        { route_id: routeA, prefix: '', rate_micros: 6000 },
        { route_id: routeB, prefix: '447', rate_micros: 7000 },
      ]);
      expect(put.status).toBe(200);
      const byPrefix = Object.fromEntries(put.body.items.map((i: { prefix: string; parent_rate_micros: number }) => [i.prefix, i.parent_rate_micros]));
      expect(byPrefix).toEqual({ '9198': 2500, '': 3000, '447': 4000 });
      expect(put.body.items[0]).toHaveProperty('route_name');

      const adminView = await as(ctx, admin).get(`/api/orgs/${client.orgId}/routes`);
      expect(adminView.status).toBe(200);
      expect(adminView.body.items.find((i: { prefix: string }) => i.prefix === '9198').parent_rate_micros).toBe(2500);

      const own = await as(ctx, client).get(`/api/orgs/${client.orgId}/routes`);
      expect(own.status).toBe(200);
      expect(own.body.items.every((i: { parent_rate_micros: unknown }) => i.parent_rate_micros === null)).toBe(true);
      expect((await as(ctx, client).get('/api/routes')).body.items.map((x: { id: string }) => x.id).sort()).toEqual([routeA, routeB].sort());
      expect((await as(ctx, client).put(`/api/orgs/${client.orgId}/routes`, [])).status).toBe(403);
    });

    it('reseller cannot assign routes it does not have, or prefixes outside its own', async () => {
      const notMine = await as(ctx, reseller).put(`/api/orgs/${client.orgId}/routes`, [{ route_id: routeC, prefix: '', rate_micros: 1 }]);
      expect(notMine.status).toBe(403);
      expect(notMine.body.details.route_id).toBe(routeC);
      const outside = await as(ctx, reseller).put(`/api/orgs/${client.orgId}/routes`, [{ route_id: routeB, prefix: '33', rate_micros: 1 }]);
      expect(outside.status).toBe(400);
      expect(outside.body.details.allowed_prefixes).toEqual(['44']);
      const unknown = await as(ctx, reseller).put(`/api/orgs/${client.orgId}/routes`, [{ route_id: '00000000-0000-4000-8000-000000000000', prefix: '', rate_micros: 1 }]);
      expect(unknown.status).toBe(403);
      const unknownByAdmin = await as(ctx, admin).put(`/api/orgs/${reseller.orgId}/routes`, [{ route_id: '00000000-0000-4000-8000-000000000000', prefix: '', rate_micros: 1 }]);
      expect(unknownByAdmin.status).toBe(400);
      // failed PUTs leave the set untouched
      expect((await as(ctx, reseller).get(`/api/orgs/${client.orgId}/routes`)).body.items).toHaveLength(3);
      // other reseller cannot touch it at all
      expect((await as(ctx, other).put(`/api/orgs/${client.orgId}/routes`, [])).status).toBe(404);
    });

    it('PUT replaces the set; removing a reseller route disables it for its clients', async () => {
      const put = await as(ctx, admin).put(`/api/orgs/${reseller.orgId}/routes`, [{ route_id: routeA, prefix: '', rate_micros: 3100 }]);
      expect(put.status).toBe(200);
      expect(put.body.items).toEqual([expect.objectContaining({ route_id: routeA, prefix: '', rate_micros: 3100 })]);
      const clientRows = await ctx.db.selectFrom('org_route_assignments').select(['route_id', 'prefix', 'enabled']).where('org_id', '=', client.orgId).execute();
      expect(clientRows.find((r) => r.route_id === routeB)?.enabled).toBe(false);
      expect(clientRows.filter((r) => r.route_id === routeA).every((r) => r.enabled)).toBe(true);
      const audit = await ctx.db.selectFrom('audit_logs').select(['before', 'after']).where('action', '=', 'route.assign').where('target_org_id', '=', reseller.orgId).orderBy('id', 'desc').executeTakeFirstOrThrow();
      expect((audit.before as unknown[]).length).toBe(3);
      expect((audit.after as unknown[]).length).toBe(1);
    });

    it('deleting a route cascades; non-admin delete is forbidden', async () => {
      expect((await as(ctx, reseller).delete(`/api/routes/${routeC}`)).status).toBe(403);
      expect((await as(ctx, admin).delete(`/api/routes/${routeC}`)).status).toBe(200);
      expect((await as(ctx, admin).get(`/api/routes/${routeC}`)).status).toBe(404);
    });
  });
});
