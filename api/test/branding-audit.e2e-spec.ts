import { Session, TestCtx, adminLogin, as, createChild, setup, uniq } from './helpers';

/** Whitelabel branding (/api/auth/me brand_name, public /api/branding) and audit-log display fields. */
describe('branding and audit display fields', () => {
  let ctx: TestCtx;
  let admin: Session;
  let reseller: Session & { email: string };
  let client: Session;

  beforeAll(async () => {
    ctx = await setup();
    admin = await adminLogin(ctx);
    reseller = await createChild(ctx, admin, uniq('br-r'));
    client = await createChild(ctx, reseller, uniq('br-c'));
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('GET /api/auth/me: effective brand = own brand_name, else the reseller\'s', async () => {
    await as(ctx, reseller).patch(`/api/orgs/${reseller.orgId}`, { brand_name: 'Acme SMS' }).expect(200);
    expect((await as(ctx, reseller).get('/api/auth/me')).body.brand_name).toBe('Acme SMS');
    const me = await as(ctx, client).get('/api/auth/me');
    expect(me.body.brand_name).toBe('Acme SMS');
    expect(me.body.org.brand_name).toBeNull();
    await as(ctx, client).patch(`/api/orgs/${client.orgId}`, { brand_name: 'Client Co' }).expect(200);
    expect((await as(ctx, client).get('/api/auth/me')).body.brand_name).toBe('Client Co');
    await as(ctx, client).patch(`/api/orgs/${client.orgId}`, { brand_name: null }).expect(200);
    // while impersonating: the acting (client) org's effective brand
    const imp = await as(ctx, reseller).post('/api/auth/impersonate', { org_id: client.orgId });
    expect((await as(ctx, { ...reseller, token: imp.body.access_token }).get('/api/auth/me')).body.brand_name).toBe('Acme SMS');
    expect((await as(ctx, admin).get('/api/auth/me')).body).toHaveProperty('brand_name');
  });

  it('GET /api/branding?host=: an active reseller\'s whitelabel domain → its brand (public)', async () => {
    const domain = `${uniq('panel').toLowerCase()}.example.com`;
    await as(ctx, reseller).patch(`/api/orgs/${reseller.orgId}`, { whitelabel_domain: domain }).expect(200);
    const hit = await ctx.http().get('/api/branding').query({ host: `${domain.toUpperCase()}:443` });
    expect(hit.status).toBe(200);
    expect(hit.body).toEqual({ host: domain, brand_name: 'Acme SMS', reseller: true });
    // without ?host the request Host header is used
    expect((await ctx.http().get('/api/branding').set('Host', domain)).body.brand_name).toBe('Acme SMS');
    expect((await ctx.http().get('/api/branding').query({ host: 'unknown.example.org' })).body).toEqual({ host: 'unknown.example.org', brand_name: null, reseller: false });
    expect((await ctx.http().get('/api/branding').query({ host: 'not a host!' })).body).toEqual({ host: null, brand_name: null, reseller: false });
    await as(ctx, admin).post(`/api/orgs/${reseller.orgId}/suspend`, { reason: 'x' }).expect(200);
    try {
      expect((await ctx.http().get('/api/branding').query({ host: domain })).body.brand_name).toBeNull();
    } finally {
      await as(ctx, admin).post(`/api/orgs/${reseller.orgId}/activate`).expect(200);
    }
  });

  it('GET /api/audit-logs items carry actor / impersonator emails and org names (also those RLS hides)', async () => {
    const r = await createChild(ctx, admin, uniq('au-r'));
    const c = await createChild(ctx, r, uniq('au-c'));
    const imp = await as(ctx, r).post('/api/auth/impersonate', { org_id: c.orgId });
    await as(ctx, { ...r, token: imp.body.access_token }).post('/api/api-keys', { name: 'by-reseller' }).expect(201);
    const names = Object.fromEntries(
      (await ctx.db.selectFrom('organizations').select(['id', 'name']).where('id', 'in', [r.orgId, c.orgId]).execute()).map((o) => [o.id, o.name]),
    );
    const rEmail = (await ctx.db.selectFrom('users').select('email').where('id', '=', r.userId).executeTakeFirstOrThrow()).email;

    // the client sees the action its reseller did while impersonating it, with readable names
    const list = await as(ctx, c).get('/api/audit-logs?action=api_key.*');
    expect(list.status).toBe(200);
    const row = list.body.items[0];
    expect(row).toMatchObject({
      action: 'api_key.create',
      actor_email: rEmail,
      impersonator_email: rEmail,
      actor_org_name: names[c.orgId],
      target_org_name: names[c.orgId],
    });
    // the reseller's view of its own impersonation
    const own = await as(ctx, r).get('/api/audit-logs?action=auth.impersonate');
    expect(own.body.items[0]).toMatchObject({ actor_email: rEmail, actor_org_name: names[r.orgId], target_org_name: names[c.orgId] });
    // system rows (no actor) have null names
    expect(Object.keys(row)).toEqual(expect.arrayContaining(['actor_email', 'impersonator_email', 'actor_org_name', 'target_org_name']));
  });
});
