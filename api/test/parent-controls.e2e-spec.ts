import { Session, TestCtx, adminLogin, as, createChild, setup, uniq } from './helpers';

/**
 * "RESELLER fully controls its CLIENTs": controls the parent sets on a client (sender IDs,
 * blocklist entries, IP whitelist rules, SMPP account settings) cannot be undone by the client.
 * The parent may also manage them while impersonating the client.
 */
describe('parent-set controls on a client', () => {
  let ctx: TestCtx;
  let admin: Session;
  let reseller: Session;
  let client: Session;
  let asClientByReseller: Session;

  beforeAll(async () => {
    ctx = await setup();
    admin = await adminLogin(ctx);
    reseller = await createChild(ctx, admin, uniq('pc-r'));
    client = await createChild(ctx, reseller, uniq('pc-c'));
    const imp = await as(ctx, reseller).post('/api/auth/impersonate', { org_id: client.orgId });
    asClientByReseller = { ...reseller, token: imp.body.access_token, refresh: imp.body.refresh_token };
  });
  afterAll(async () => {
    await ctx.close();
  });

  const forClient = (path: string) => `${path}?org_id=${client.orgId}`;

  it('sender IDs: the client may withdraw its own PENDING request, never a reviewed / parent-created row', async () => {
    const parentRow = await as(ctx, reseller).post(forClient('/api/sender-ids'), { sender: 'BANKX' });
    expect(parentRow.status).toBe(201);
    expect(parentRow.body.status).toBe('APPROVED');
    const del = await as(ctx, client).delete(`/api/sender-ids/${parentRow.body.id}`);
    expect(del.status).toBe(403);

    const own = await as(ctx, client).post('/api/sender-ids', { sender: 'MINE' });
    expect(own.body.status).toBe('PENDING');
    await as(ctx, reseller).post(`/api/sender-ids/${own.body.id}/reject`).expect(200);
    expect((await as(ctx, client).delete(`/api/sender-ids/${own.body.id}`)).status).toBe(403);

    const pending = await as(ctx, client).post('/api/sender-ids', { sender: 'OTHER' });
    expect((await as(ctx, client).delete(`/api/sender-ids/${pending.body.id}`)).status).toBe(200);

    // created by the reseller while impersonating → auto-approved; it may delete everything
    const viaImp = await as(ctx, asClientByReseller).post('/api/sender-ids', { sender: 'IMPX' });
    expect(viaImp.body.status).toBe('APPROVED');
    expect((await as(ctx, asClientByReseller).delete(`/api/sender-ids/${own.body.id}`)).status).toBe(200);
    expect((await as(ctx, reseller).delete(`/api/sender-ids/${parentRow.body.id}`)).status).toBe(200);
    const left = await ctx.db.selectFrom('sender_ids').select('sender').where('org_id', '=', client.orgId).execute();
    expect(left.map((r) => r.sender)).toEqual(['IMPX']);
  });

  it('blocklist: entries the reseller added for the client can only be removed by the reseller', async () => {
    const num = await as(ctx, reseller).post(forClient('/api/blocklist/numbers'), { prefix: '+44 7700 900111' });
    expect(num.status).toBe(201);
    expect(num.body.created_by_org_id).toBe(reseller.orgId);
    const kw = await as(ctx, asClientByReseller).post('/api/blocklist/keywords', { pattern: 'casino' });
    expect(kw.status).toBe(201);
    expect(kw.body.created_by_org_id).toBe(reseller.orgId);
    expect((await as(ctx, client).delete(`/api/blocklist/numbers/${num.body.id}`)).status).toBe(403);
    expect((await as(ctx, client).delete(`/api/blocklist/keywords/${kw.body.id}`)).status).toBe(403);

    const own = await as(ctx, client).post('/api/blocklist/numbers', { prefix: '447700900222' });
    expect(own.body.created_by_org_id).toBe(client.orgId);
    expect((await as(ctx, client).delete(`/api/blocklist/numbers/${own.body.id}`)).status).toBe(200);

    expect((await as(ctx, asClientByReseller).delete(`/api/blocklist/numbers/${num.body.id}`)).status).toBe(200);
    expect((await as(ctx, reseller).delete(`/api/blocklist/keywords/${kw.body.id}`)).status).toBe(200);
  });

  it('IP whitelist: the client can neither remove the reseller\'s rule nor widen it with its own', async () => {
    const rule = await as(ctx, reseller).post(forClient('/api/ip-whitelist'), { cidr: '198.51.100.0/24', scope: 'API' });
    expect(rule.status).toBe(201);
    expect((await as(ctx, client).delete(`/api/ip-whitelist/${rule.body.id}`)).status).toBe(403);
    // an own rule would admit more addresses for API (directly, or through ALL)
    expect((await as(ctx, client).post('/api/ip-whitelist', { cidr: '0.0.0.0/0', scope: 'API' })).status).toBe(403);
    expect((await as(ctx, client).post('/api/ip-whitelist', { cidr: '0.0.0.0/0', scope: 'ALL' })).status).toBe(403);
    // an unrelated scope it may still restrict itself
    const smpp = await as(ctx, client).post('/api/ip-whitelist', { cidr: '192.0.2.0/24', scope: 'SMPP' });
    expect(smpp.status).toBe(201);
    expect((await as(ctx, client).delete(`/api/ip-whitelist/${smpp.body.id}`)).status).toBe(200);
    // the reseller manages it (also as the client)
    expect((await as(ctx, asClientByReseller).post('/api/ip-whitelist', { cidr: '203.0.113.0/24', scope: 'API' })).status).toBe(201);
    expect((await as(ctx, reseller).delete(`/api/ip-whitelist/${rule.body.id}`)).status).toBe(200);
  });

  it('SMPP accounts: a reseller-disabled / limited account cannot be re-enabled, loosened or deleted by the client', async () => {
    const acc = await as(ctx, reseller).post(forClient('/api/smpp-accounts'), {
      system_id: uniq('pc').replace(/[^a-z0-9]/gi, '').slice(-15),
      password: 'pw123456',
      max_binds: 2,
      max_tps: 20,
      allowed_bind_types: ['TX', 'TRX'],
    });
    expect(acc.status).toBe(201);
    expect(acc.body.locked_by_parent).toBe(true);
    await as(ctx, reseller).patch(`/api/smpp-accounts/${acc.body.id}`, { enabled: false }).expect(200);

    const reEnable = await as(ctx, client).patch(`/api/smpp-accounts/${acc.body.id}`, { enabled: true });
    expect(reEnable.status).toBe(403);
    expect(reEnable.body.details.fields).toEqual(['enabled']);
    expect((await as(ctx, client).patch(`/api/smpp-accounts/${acc.body.id}`, { max_binds: 5 })).status).toBe(403);
    expect((await as(ctx, client).patch(`/api/smpp-accounts/${acc.body.id}`, { max_tps: null })).status).toBe(403);
    expect((await as(ctx, client).patch(`/api/smpp-accounts/${acc.body.id}`, { allowed_bind_types: ['TX', 'TRX', 'RX'] })).status).toBe(403);
    expect((await as(ctx, client).delete(`/api/smpp-accounts/${acc.body.id}`)).status).toBe(403);
    // tightening is fine
    const tighter = await as(ctx, client).patch(`/api/smpp-accounts/${acc.body.id}`, { max_tps: 5, max_binds: 1, allowed_bind_types: ['TRX'] });
    expect(tighter.status).toBe(200);
    expect(tighter.body).toMatchObject({ enabled: false, max_tps: 5, max_binds: 1, allowed_bind_types: ['TRX'] });
    // the reseller (also while impersonating) re-enables it
    const on = await as(ctx, asClientByReseller).patch(`/api/smpp-accounts/${acc.body.id}`, { enabled: true });
    expect(on.status).toBe(200);
    expect(on.body.enabled).toBe(true);

    // an account the client created and the reseller never touched stays the client's
    const own = await as(ctx, client).post('/api/smpp-accounts', { system_id: uniq('own').replace(/[^a-z0-9]/gi, '').slice(-15), password: 'pw123456' });
    expect(own.body.locked_by_parent).toBe(false);
    await as(ctx, client).patch(`/api/smpp-accounts/${own.body.id}`, { enabled: false }).expect(200);
    await as(ctx, client).patch(`/api/smpp-accounts/${own.body.id}`, { enabled: true, max_binds: 4 }).expect(200);
    expect((await as(ctx, client).delete(`/api/smpp-accounts/${own.body.id}`)).status).toBe(200);
  });
});
