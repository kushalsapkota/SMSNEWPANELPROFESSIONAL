import { TestCtx, adminLogin, as, createChild, setup, uniq, waitFor } from './helpers';

describe('hierarchy & org management', () => {
  let ctx: TestCtx;

  beforeAll(async () => {
    ctx = await setup();
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(() => ctx.engine.reset());

  it('admin creates a reseller with owner user, balance and notification defaults in one go', async () => {
    const admin = await adminLogin(ctx);
    const email = `${uniq('res')}@test.local`;
    const res = await as(ctx, admin).post('/api/orgs', {
      name: 'Acme Reseller',
      email,
      password: 'Reseller-Passw0rd',
      full_name: 'Ann Owner',
      brand_name: 'Acme',
      max_tps: 50,
      billing_mode: 'POSTPAID',
      credit_limit_micros: 5_000_000,
      currency: 'eur',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      role: 'RESELLER',
      parent_id: admin.orgId,
      name: 'Acme Reseller',
      brand_name: 'Acme',
      max_tps: 50,
      owner: { email, full_name: 'Ann Owner' },
      balance: { billing_mode: 'POSTPAID', credit_limit_micros: 5_000_000, currency: 'EUR', balance_micros: 0 },
    });
    expect(res.body.owner.password_hash).toBeUndefined();
    const id = res.body.id;
    const ns = await ctx.db.selectFrom('notification_settings').selectAll().where('org_id', '=', id).executeTakeFirstOrThrow();
    expect(ns.email_to).toEqual([email]);
    const user = await ctx.db.selectFrom('users').select('password_hash').where('email', '=', email).executeTakeFirstOrThrow();
    expect(user.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);

    const audit = await ctx.db.selectFrom('audit_logs').selectAll().where('action', '=', 'reseller.create').where('entity_id', '=', id).executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ actor_user_id: admin.userId, actor_org_id: admin.orgId, target_org_id: id });
    expect(JSON.stringify(audit.after)).not.toMatch(/argon2|password_hash/);
    await waitFor(() => ctx.invalidations.some((m) => m.entity === 'organizations' && m.id === id));
  });

  it('rejects duplicate owner email (409) and PREPAID with credit limit (400)', async () => {
    const admin = await adminLogin(ctx);
    const r = await createChild(ctx, admin, uniq('dup'));
    const dup = await as(ctx, admin).post('/api/orgs', { name: 'x', email: r.email, password: 'Whatever-123' });
    expect(dup.status).toBe(409);
    expect(dup.body.error_code).toBe('CONFLICT');
    const bad = await as(ctx, admin).post('/api/orgs', { name: 'x', email: `${uniq('p')}@test.local`, password: 'Whatever-123', credit_limit_micros: 5 });
    expect(bad.status).toBe(400);
    // nothing half-created
    const orgs = await ctx.db.selectFrom('organizations').select('id').where('name', '=', 'x').execute();
    expect(orgs).toHaveLength(0);
  });

  it('reseller creates clients; the role is implied by the acting org; clients cannot create orgs', async () => {
    const admin = await adminLogin(ctx);
    const reseller = await createChild(ctx, admin, uniq('r'));
    const client = await createChild(ctx, reseller, uniq('c'));
    const got = await as(ctx, reseller).get(`/api/orgs/${client.orgId}`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ role: 'CLIENT', parent_id: reseller.orgId, effective_state: { can_send: true, can_api: true, can_smpp: false } });
    expect(got.body.counts).toMatchObject({ users: 1, api_keys: 0 });

    const deny = await as(ctx, client).post('/api/orgs', { name: 'nope', email: `${uniq('n')}@test.local`, password: 'Whatever-123' });
    expect(deny.status).toBe(403);
    expect(deny.body.error_code).toBe('FORBIDDEN');

    // An admin POST always creates a RESELLER — clients are only reachable via a reseller (or impersonation).
    const viaAdmin = await as(ctx, admin).post('/api/orgs', { name: uniq('a'), email: `${uniq('a')}@test.local`, password: 'Whatever-123' });
    expect(viaAdmin.body.role).toBe('RESELLER');
    const role = await as(ctx, admin).post('/api/orgs', { name: 'x', email: `${uniq('a')}@test.local`, password: 'Whatever-123', role: 'CLIENT' });
    expect(role.status).toBe(400);
  });

  it('lists children per role', async () => {
    const admin = await adminLogin(ctx);
    const reseller = await createChild(ctx, admin, uniq('list-r'));
    const c1 = await createChild(ctx, reseller, uniq('list-c'));
    const adminList = await as(ctx, admin).get('/api/orgs?page_size=200');
    expect(adminList.status).toBe(200);
    expect(adminList.body.items.every((o: { role: string }) => o.role === 'RESELLER')).toBe(true);
    expect(adminList.body.items.find((o: { id: string }) => o.id === reseller.orgId)).toMatchObject({ child_count: 1 });
    const clients = await as(ctx, admin).get(`/api/orgs?parent_id=${reseller.orgId}`);
    expect(clients.body.items.map((o: { id: string }) => o.id)).toEqual([c1.orgId]);
    const rl = await as(ctx, reseller).get('/api/orgs');
    expect(rl.body).toMatchObject({ total: 1, page: 1, page_size: 50 });
    expect(rl.body.items[0].id).toBe(c1.orgId);
    const search = await as(ctx, reseller).get(`/api/orgs?q=${encodeURIComponent(c1.email.split('@')[0].slice(0, 12))}`);
    expect(search.status).toBe(200);
    expect((await as(ctx, c1).get('/api/orgs')).status).toBe(403);
  });

  it('reseller suspends / activates its client: kicks SMPP, blocks login, audited, invalidated', async () => {
    const admin = await adminLogin(ctx);
    const reseller = await createChild(ctx, admin, uniq('sus-r'));
    const client = await createChild(ctx, reseller, uniq('sus-c'));

    expect((await as(ctx, reseller).post(`/api/orgs/${client.orgId}/suspend`, {})).status).toBe(400);
    const sus = await as(ctx, reseller).post(`/api/orgs/${client.orgId}/suspend`, { reason: 'unpaid invoice' });
    expect(sus.status).toBe(200);
    expect(sus.body).toMatchObject({ status: 'SUSPENDED', suspended_reason: 'unpaid invoice' });
    expect(ctx.engine.calls('/internal/v1/smpp/sessions/kick').map((c) => c.body)).toEqual([{ org_id: client.orgId }]);
    expect(ctx.engine.requests[0].token).toBe(process.env.INTERNAL_TOKEN);
    // the engine reloads its config synchronously before the kick (no debounce window for re-binds)
    expect(ctx.engine.requests.map((r) => r.path)).toEqual(['/internal/v1/config/reload', '/internal/v1/smpp/sessions/kick']);

    const loginRes = await ctx.http().post('/api/auth/login').send({ email: client.email, password: client.password });
    expect(loginRes.status).toBe(403);
    expect(loginRes.body.error_code).toBe('ACCOUNT_SUSPENDED');
    // existing access tokens stop working too
    const me = await as(ctx, client).get('/api/auth/me');
    expect(me.body.error_code).toBe('ACCOUNT_SUSPENDED');

    const act = await as(ctx, reseller).post(`/api/orgs/${client.orgId}/activate`);
    expect(act.body.status).toBe('ACTIVE');
    expect(ctx.engine.calls('/internal/v1/config/reload')).toHaveLength(2);
    expect(ctx.engine.calls('/internal/v1/smpp/sessions/kick')).toHaveLength(1);
    expect((await as(ctx, client).get('/api/auth/me')).status).toBe(200);

    const actions = await ctx.db.selectFrom('audit_logs').select(['action', 'before', 'after']).where('target_org_id', '=', client.orgId).where('action', 'in', ['client.suspend', 'client.activate']).orderBy('id').execute();
    expect(actions.map((a) => a.action)).toEqual(['client.suspend', 'client.activate']);
    expect(actions[0].before).toMatchObject({ status: 'ACTIVE' });
    expect(actions[0].after).toMatchObject({ status: 'SUSPENDED' });
    await waitFor(() => ctx.invalidations.filter((m) => m.entity === 'organizations' && m.id === client.orgId).length >= 3);
  });

  it('suspending a reseller kicks its clients too, and blocks them', async () => {
    const admin = await adminLogin(ctx);
    const reseller = await createChild(ctx, admin, uniq('sr'));
    const c1 = await createChild(ctx, reseller, uniq('sc1'));
    await as(ctx, admin).post(`/api/orgs/${reseller.orgId}/suspend`, { reason: 'fraud review' }).expect(200);
    const kicked = ctx.engine.calls('/internal/v1/smpp/sessions/kick').map((c) => (c.body as { org_id: string }).org_id);
    expect(kicked.sort()).toEqual([reseller.orgId, c1.orgId].sort());
    const res = await ctx.http().post('/api/auth/login').send({ email: c1.email, password: c1.password });
    expect(res.body.error_code).toBe('ACCOUNT_SUSPENDED');
    await as(ctx, admin).post(`/api/orgs/${reseller.orgId}/activate`).expect(200);
  });

  it('channels: toggles flags; disabling SMPP kicks sessions', async () => {
    const admin = await adminLogin(ctx);
    const reseller = await createChild(ctx, admin, uniq('ch-r'));
    const client = await createChild(ctx, reseller, uniq('ch-c'));
    const on = await as(ctx, reseller).patch(`/api/orgs/${client.orgId}/channels`, { smpp_enabled: true, api_enabled: false });
    expect(on.body).toMatchObject({ smpp_enabled: true, api_enabled: false });
    expect(ctx.engine.calls('/internal/v1/smpp/sessions/kick')).toHaveLength(0);
    const off = await as(ctx, reseller).patch(`/api/orgs/${client.orgId}/channels`, { smpp_enabled: false, sending_enabled: false });
    expect(off.body).toMatchObject({ smpp_enabled: false, sending_enabled: false });
    expect(ctx.engine.calls('/internal/v1/smpp/sessions/kick')).toHaveLength(1);
    // turning sending back on does not kick; turning only sending off does (bind needs can_send)
    await as(ctx, reseller).patch(`/api/orgs/${client.orgId}/channels`, { smpp_enabled: true, sending_enabled: true }).expect(200);
    expect(ctx.engine.calls('/internal/v1/smpp/sessions/kick')).toHaveLength(1);
    await as(ctx, reseller).patch(`/api/orgs/${client.orgId}/channels`, { sending_enabled: false }).expect(200);
    expect(ctx.engine.calls('/internal/v1/smpp/sessions/kick')).toHaveLength(2);
    expect(ctx.engine.calls('/internal/v1/config/reload')).toHaveLength(4);
    const st = await as(ctx, client).get(`/api/orgs/${client.orgId}`);
    expect(st.body.effective_state).toMatchObject({ is_active: true, can_send: false, can_smpp: false });
    // a client cannot toggle its own channels
    expect((await as(ctx, client).patch(`/api/orgs/${client.orgId}/channels`, { sending_enabled: true })).status).toBe(403);
  });

  it('kick failures (engine down) do not fail the management action', async () => {
    const admin = await adminLogin(ctx);
    const reseller = await createChild(ctx, admin, uniq('down-r'));
    const client = await createChild(ctx, reseller, uniq('down-c'));
    ctx.engine.down = true;
    const sus = await as(ctx, reseller).post(`/api/orgs/${client.orgId}/suspend`, { reason: 'x' });
    expect(sus.status).toBe(200);
    const row = await ctx.db.selectFrom('organizations').select('status').where('id', '=', client.orgId).executeTakeFirstOrThrow();
    expect(row.status).toBe('SUSPENDED');
  });

  it('PATCH: parent edits limits; org edits only its own branding fields', async () => {
    const admin = await adminLogin(ctx);
    const reseller = await createChild(ctx, admin, uniq('pt-r'));
    const client = await createChild(ctx, reseller, uniq('pt-c'));
    const p = await as(ctx, reseller).patch(`/api/orgs/${client.orgId}`, { max_tps: 5, daily_limit: 1000, timezone: 'Asia/Kolkata' });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ max_tps: 5, daily_limit: 1000, timezone: 'Asia/Kolkata' });
    expect((await as(ctx, reseller).patch(`/api/orgs/${client.orgId}`, { timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await as(ctx, client).patch(`/api/orgs/${client.orgId}`, { max_tps: 500 })).status).toBe(403);
    expect((await as(ctx, client).patch(`/api/orgs/${client.orgId}`, { brand_name: 'MyBrand' })).body.brand_name).toBe('MyBrand');
    const wl = await as(ctx, reseller).patch(`/api/orgs/${reseller.orgId}`, { whitelabel_domain: `${uniq('wl')}.example.com` });
    expect(wl.status).toBe(200);
    expect((await as(ctx, client).patch(`/api/orgs/${client.orgId}`, { whitelabel_domain: 'x.example.com' })).status).toBe(400);
    const audit = await ctx.db.selectFrom('audit_logs').select(['before', 'after']).where('action', '=', 'org.update').where('target_org_id', '=', client.orgId).orderBy('id').executeTakeFirstOrThrow();
    expect(audit.before).toMatchObject({ max_tps: 10 });
    expect(audit.after).toMatchObject({ max_tps: 5 });
  });

  it('admin is read-only on clients (403 on writes) but may act via impersonation', async () => {
    const admin = await adminLogin(ctx);
    const reseller = await createChild(ctx, admin, uniq('ro-r'));
    const client = await createChild(ctx, reseller, uniq('ro-c'));
    expect((await as(ctx, admin).get(`/api/orgs/${client.orgId}`)).status).toBe(200);
    expect((await as(ctx, admin).post(`/api/orgs/${client.orgId}/suspend`, { reason: 'x' })).status).toBe(403);
    expect((await as(ctx, admin).patch(`/api/orgs/${client.orgId}`, { max_tps: 1 })).status).toBe(403);
    expect((await as(ctx, admin).post(`/api/orgs/${client.orgId}/users`, { email: `${uniq('u')}@test.local`, password: 'Whatever-123' })).status).toBe(403);

    const imp = await as(ctx, admin).post('/api/auth/impersonate', { org_id: reseller.orgId });
    const asReseller = { ...admin, token: imp.body.access_token };
    expect((await as(ctx, asReseller).post(`/api/orgs/${client.orgId}/suspend`, { reason: 'admin via reseller' })).status).toBe(200);
  });

  it('users: list, add, reset password (revokes sessions), deactivate', async () => {
    const admin = await adminLogin(ctx);
    const reseller = await createChild(ctx, admin, uniq('us-r'));
    const client = await createChild(ctx, reseller, uniq('us-c'));
    const email = `${uniq('second')}@test.local`;
    const add = await as(ctx, client).post(`/api/orgs/${client.orgId}/users`, { email, password: 'Second-Passw0rd', full_name: 'Second' });
    expect(add.status).toBe(201);
    const list = await as(ctx, reseller).get(`/api/orgs/${client.orgId}/users`);
    expect(list.body.total).toBe(2);
    expect(list.body.items[0].password_hash).toBeUndefined();

    const second = await ctx.http().post('/api/auth/login').send({ email, password: 'Second-Passw0rd' });
    const reset = await as(ctx, reseller).post(`/api/orgs/${client.orgId}/users/${add.body.id}/reset-password`, { new_password: 'Reset-Passw0rd' });
    expect(reset.status).toBe(200);
    expect((await ctx.http().post('/api/auth/refresh').send({ refresh_token: second.body.refresh_token })).status).toBe(401);
    await ctx.http().post('/api/auth/login').send({ email, password: 'Reset-Passw0rd' }).expect(200);

    const off = await as(ctx, reseller).patch(`/api/orgs/${client.orgId}/users/${add.body.id}`, { is_active: false });
    expect(off.body.is_active).toBe(false);
    expect((await ctx.http().post('/api/auth/login').send({ email, password: 'Reset-Passw0rd' })).status).toBe(401);
    expect((await as(ctx, client).patch(`/api/orgs/${client.orgId}/users/${client.userId}`, { is_active: false })).status).toBe(403);
  });

  it('users: only the parent resets passwords or (de)activates users; the org itself cannot undo it', async () => {
    const admin = await adminLogin(ctx);
    const reseller = await createChild(ctx, admin, uniq('up-r'));
    const client = await createChild(ctx, reseller, uniq('up-c'));
    const email = `${uniq('colleague')}@test.local`;
    const add = await as(ctx, client).post(`/api/orgs/${client.orgId}/users`, { email, password: 'Second-Passw0rd' });
    expect(add.status).toBe(201);

    // Self-service reset without the current password / 2FA: refused (own user and a colleague).
    const self = await as(ctx, client).post(`/api/orgs/${client.orgId}/users/${client.userId}/reset-password`, { new_password: 'Hijack-Passw0rd' });
    expect(self.status).toBe(403);
    expect((await as(ctx, client).post(`/api/orgs/${client.orgId}/users/${add.body.id}/reset-password`, { new_password: 'Hijack-Passw0rd' })).status).toBe(403);
    expect((await ctx.http().post('/api/auth/login').send({ email: client.email, password: 'Hijack-Passw0rd' })).status).toBe(401);

    // The reseller deactivates the colleague; the client can't re-activate it, but may rename it.
    await as(ctx, reseller).patch(`/api/orgs/${client.orgId}/users/${add.body.id}`, { is_active: false }).expect(200);
    expect((await as(ctx, client).patch(`/api/orgs/${client.orgId}/users/${add.body.id}`, { is_active: true })).status).toBe(403);
    const renamed = await as(ctx, client).patch(`/api/orgs/${client.orgId}/users/${add.body.id}`, { full_name: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ full_name: 'Renamed', is_active: false });

    // The admin is read-only on clients.
    expect((await as(ctx, admin).post(`/api/orgs/${client.orgId}/users/${add.body.id}/reset-password`, { new_password: 'Admin-Passw0rd' })).status).toBe(403);

    // The parent may also do it while impersonating the client.
    const imp = await as(ctx, reseller).post('/api/auth/impersonate', { org_id: client.orgId });
    const asClient = { ...reseller, token: imp.body.access_token };
    expect((await as(ctx, asClient).patch(`/api/orgs/${client.orgId}/users/${add.body.id}`, { is_active: true })).status).toBe(200);
    expect((await as(ctx, asClient).post(`/api/orgs/${client.orgId}/users/${add.body.id}/reset-password`, { new_password: 'Reset-Passw0rd' })).status).toBe(200);
    await ctx.http().post('/api/auth/login').send({ email, password: 'Reset-Passw0rd' }).expect(200);
  });
});
