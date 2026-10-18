import { sql } from 'kysely';
import { Session, TestCtx, adminLogin, as, createChild, setup, uniq } from './helpers';
import { createKysely } from '../src/db/db.service';

/**
 * Reseller A must not read or modify reseller B's clients or anything they own
 * (404 for ids hidden by RLS, 403 for out-of-scope ?org_id).
 */
describe('tenancy isolation', () => {
  let ctx: TestCtx;
  let admin: Session;
  let rA: Session;
  let rB: Session;
  let cA: Session;
  let cB: Session;
  let cA2: Session;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    ctx = await setup();
    admin = await adminLogin(ctx);
    rA = await createChild(ctx, admin, uniq('ten-rA'));
    rB = await createChild(ctx, admin, uniq('ten-rB'));
    cA = await createChild(ctx, rA, uniq('ten-cA'));
    cA2 = await createChild(ctx, rA, uniq('ten-cA2'));
    cB = await createChild(ctx, rB, uniq('ten-cB'));
    // B's client owns one of everything.
    const b = as(ctx, cB);
    ids.key = (await b.post('/api/api-keys', { name: 'k' }).expect(201)).body.id;
    ids.smpp = (await b.post('/api/smpp-accounts', { system_id: uniq('sb').slice(-15), password: 'pw12' }).expect(201)).body.id;
    ids.ip = (await b.post('/api/ip-whitelist', { cidr: '10.1.0.0/16', scope: 'API' }).expect(201)).body.id;
    ids.hook = (await b.post('/api/webhooks', { url: 'https://hooks.example.com/dlr' }).expect(201)).body.id;
    ids.sender = (await b.post('/api/sender-ids', { sender: 'BANKB' }).expect(201)).body.id;
    ids.blockNum = (await b.post('/api/blocklist/numbers', { prefix: '4477' }).expect(201)).body.id;
    ids.blockKw = (await b.post('/api/blocklist/keywords', { pattern: 'casino' }).expect(201)).body.id;
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('A cannot see B or B’s client (404) and lists only its own clients', async () => {
    const a = as(ctx, rA);
    expect((await a.get(`/api/orgs/${cB.orgId}`)).status).toBe(404);
    expect((await a.get(`/api/orgs/${rB.orgId}`)).status).toBe(404);
    expect((await a.get(`/api/orgs/${admin.orgId}`)).status).toBe(404);
    const list = await a.get('/api/orgs');
    expect(list.body.items.map((o: { id: string }) => o.id).sort()).toEqual([cA.orgId, cA2.orgId].sort());
    // admin filtering by parent_id of A doesn't leak either
    const viaParent = await a.get(`/api/orgs?parent_id=${rB.orgId}`);
    expect(viaParent.body.items.map((o: { id: string }) => o.id).sort()).toEqual([cA.orgId, cA2.orgId].sort());
  });

  it('A cannot modify B’s client (404)', async () => {
    const a = as(ctx, rA);
    expect((await a.patch(`/api/orgs/${cB.orgId}`, { max_tps: 1 })).status).toBe(404);
    expect((await a.post(`/api/orgs/${cB.orgId}/suspend`, { reason: 'x' })).status).toBe(404);
    expect((await a.post(`/api/orgs/${cB.orgId}/activate`)).status).toBe(404);
    expect((await a.patch(`/api/orgs/${cB.orgId}/channels`, { sending_enabled: false })).status).toBe(404);
    expect((await a.get(`/api/orgs/${cB.orgId}/users`)).status).toBe(404);
    expect((await a.post(`/api/orgs/${cB.orgId}/users`, { email: `${uniq('x')}@test.local`, password: 'Whatever-123' })).status).toBe(404);
    expect((await a.post(`/api/orgs/${cB.orgId}/users/${cB.userId}/reset-password`, { new_password: 'Hijack-Passw0rd' })).status).toBe(404);
    expect((await a.get(`/api/orgs/${cB.orgId}/balance`)).status).toBe(404);
    expect((await a.post(`/api/orgs/${cB.orgId}/balance/topup`, { amount_micros: 1 })).status).toBe(404);
    expect((await a.get(`/api/orgs/${cB.orgId}/transactions`)).status).toBe(404);
    expect((await a.get(`/api/orgs/${cB.orgId}/routes`)).status).toBe(404);
    expect((await a.put(`/api/orgs/${cB.orgId}/routes`, [])).status).toBe(404);
    const row = await ctx.db.selectFrom('organizations').select(['max_tps', 'status', 'sending_enabled']).where('id', '=', cB.orgId).executeTakeFirstOrThrow();
    expect(row).toEqual({ max_tps: 10, status: 'ACTIVE', sending_enabled: true });
  });

  it.each([
    ['/api/api-keys'],
    ['/api/smpp-accounts'],
    ['/api/ip-whitelist'],
    ['/api/webhooks'],
    ['/api/sender-ids'],
    ['/api/blocklist/numbers'],
    ['/api/blocklist/keywords'],
    ['/api/notifications/settings'],
  ])('A gets 403 for ?org_id=<B client> on GET %s', async (path) => {
    const r = await as(ctx, rA).get(`${path}?org_id=${cB.orgId}`);
    expect(r.status).toBe(403);
    expect(r.body.error_code).toBe('FORBIDDEN');
    // and also for a sibling client of its own clients
    expect((await as(ctx, cA).get(`${path}?org_id=${cA2.orgId}`)).status).toBe(403);
    // non-existent org ids are indistinguishable
    expect((await as(ctx, rA).get(`${path}?org_id=00000000-0000-4000-8000-000000000000`)).status).toBe(403);
  });

  it('A gets 403 creating resources for B’s client', async () => {
    const a = as(ctx, rA);
    expect((await a.post(`/api/api-keys?org_id=${cB.orgId}`, { name: 'steal' })).status).toBe(403);
    expect((await a.post(`/api/smpp-accounts?org_id=${cB.orgId}`, { system_id: 'stealer', password: 'x' })).status).toBe(403);
    expect((await a.post(`/api/ip-whitelist?org_id=${cB.orgId}`, { cidr: '1.2.3.4' })).status).toBe(403);
    expect((await a.post(`/api/webhooks?org_id=${cB.orgId}`, { url: 'https://evil.example.com' })).status).toBe(403);
    expect((await a.post(`/api/sender-ids?org_id=${cB.orgId}`, { sender: 'EVIL' })).status).toBe(403);
    expect((await a.put(`/api/notifications/settings?org_id=${cB.orgId}`, { email_to: ['evil@x.com'] })).status).toBe(403);
  });

  it('A gets 404 touching B’s client resources by id; nothing changes', async () => {
    const a = as(ctx, rA);
    expect((await a.delete(`/api/api-keys/${ids.key}`)).status).toBe(404);
    expect((await a.patch(`/api/smpp-accounts/${ids.smpp}`, { enabled: false })).status).toBe(404);
    expect((await a.post(`/api/smpp-accounts/${ids.smpp}/password`, { password: 'pwn' })).status).toBe(404);
    expect((await a.delete(`/api/smpp-accounts/${ids.smpp}`)).status).toBe(404);
    expect((await a.delete(`/api/ip-whitelist/${ids.ip}`)).status).toBe(404);
    expect((await a.patch(`/api/webhooks/${ids.hook}`, { url: 'https://evil.example.com' })).status).toBe(404);
    expect((await a.post(`/api/webhooks/${ids.hook}/test`)).status).toBe(404);
    expect((await a.get(`/api/webhooks/${ids.hook}/deliveries`)).status).toBe(404);
    expect((await a.delete(`/api/webhooks/${ids.hook}`)).status).toBe(404);
    expect((await a.post(`/api/sender-ids/${ids.sender}/approve`)).status).toBe(404);
    expect((await a.delete(`/api/sender-ids/${ids.sender}`)).status).toBe(404);
    expect((await a.delete(`/api/blocklist/numbers/${ids.blockNum}`)).status).toBe(404);
    expect((await a.delete(`/api/blocklist/keywords/${ids.blockKw}`)).status).toBe(404);

    const key = await ctx.db.selectFrom('api_keys').select('revoked_at').where('id', '=', ids.key).executeTakeFirstOrThrow();
    expect(key.revoked_at).toBeNull();
    const smpp = await ctx.db.selectFrom('smpp_accounts').select('enabled').where('id', '=', ids.smpp).executeTakeFirstOrThrow();
    expect(smpp.enabled).toBe(true);
    expect(await ctx.db.selectFrom('ip_whitelists').select('id').where('id', '=', ids.ip).executeTakeFirst()).toBeDefined();
    const hook = await ctx.db.selectFrom('webhooks').select('url').where('id', '=', ids.hook).executeTakeFirstOrThrow();
    expect(hook.url).toBe('https://hooks.example.com/dlr');
    const sender = await ctx.db.selectFrom('sender_ids').select('status').where('id', '=', ids.sender).executeTakeFirstOrThrow();
    expect(sender.status).toBe('PENDING');
  });

  it('B’s reseller can act on them; a client cannot act on its own parent', async () => {
    const b = as(ctx, rB);
    const keys = await b.get(`/api/api-keys?org_id=${cB.orgId}`);
    expect(keys.status).toBe(200);
    expect(keys.body.items.map((k: { id: string }) => k.id)).toEqual([ids.key]);
    expect(keys.body.items[0].key_hash).toBeUndefined();
    expect((await as(ctx, cB).get(`/api/api-keys?org_id=${rB.orgId}`)).status).toBe(403);
    expect((await as(ctx, cB).get(`/api/orgs/${rB.orgId}`)).status).toBe(404);
  });

  it('admin reads client resources but may not write them', async () => {
    const ad = as(ctx, admin);
    expect((await ad.get(`/api/api-keys?org_id=${cB.orgId}`)).status).toBe(200);
    expect((await ad.post(`/api/api-keys?org_id=${cB.orgId}`, { name: 'admin-key' })).status).toBe(403);
    expect((await ad.delete(`/api/api-keys/${ids.key}`)).status).toBe(403);
    expect((await ad.post(`/api/api-keys?org_id=${rB.orgId}`, { name: 'reseller-key' })).status).toBe(201);
  });

  it('audit logs only show what the caller may see', async () => {
    const aLogs = await as(ctx, rA).get('/api/audit-logs?page_size=200');
    expect(aLogs.status).toBe(200);
    const targets = new Set(aLogs.body.items.map((l: { target_org_id: string }) => l.target_org_id));
    expect(targets.has(cB.orgId)).toBe(false);
    expect(targets.has(rB.orgId)).toBe(false);
    expect((await as(ctx, rA).get(`/api/audit-logs?org_id=${cB.orgId}`)).status).toBe(403);
    const bLogs = await as(ctx, rB).get(`/api/audit-logs?org_id=${cB.orgId}&action=api_key.*`);
    expect(bLogs.body.items.map((l: { action: string }) => l.action)).toContain('api_key.create');
  });

  it('RLS enforces the same isolation underneath the code checks', async () => {
    const tenant = createKysely(process.env.DATABASE_URL as string, 1, 'rls-probe');
    try {
      const visible = await tenant.transaction().execute(async (trx) => {
        await sql`select set_config('app.org_id', ${rA.orgId}, true), set_config('app.role', 'RESELLER', true)`.execute(trx);
        return trx.selectFrom('api_keys').select('id').where('id', '=', ids.key).execute();
      });
      expect(visible).toHaveLength(0);
      const none = await tenant.selectFrom('organizations').select('id').execute();
      expect(none).toHaveLength(0); // no tenant context = nothing
    } finally {
      await tenant.destroy();
    }
  });
});
