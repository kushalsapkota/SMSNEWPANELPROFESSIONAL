import { CryptoService } from '../src/crypto/crypto.service';
import { loadConfig } from '../src/config/config';
import { Session, TestCtx, adminLogin, as, createChild, setup, uniq, waitFor } from './helpers';

describe('POST /api/routes/quick + GET /api/routes/:id/status', () => {
  let ctx: TestCtx;
  let admin: Session;
  let reseller: Session;
  let existingId: string;

  const smpp = (over: Record<string, unknown> = {}) => ({
    type: 'SMPP',
    host: '10.20.30.40',
    port: 2775,
    system_id: uniq('u').slice(-15),
    password: 'pw123',
    ...over,
  });

  beforeAll(async () => {
    ctx = await setup();
    admin = await adminLogin(ctx);
    reseller = await createChild(ctx, admin, uniq('qr-r'));
    const c = await as(ctx, admin).post('/api/connections', {
      name: uniq('existing'),
      host: 'smsc.example.net',
      port: 2775,
      system_id: 'exist',
      password: 'ex',
      max_tps: 10,
    });
    existingId = c.body.id;
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('creates route + inline SMPP connection + rate in one call; password never returned', async () => {
    const name = uniq('Quick');
    ctx.invalidations.length = 0;
    const res = await as(ctx, admin).post('/api/routes/quick', {
      name,
      description: 'one step',
      connections: [smpp({ password: 'S3cr3t!', cost_micros: 2500, bind_type: 'TX', max_tps: 20 })],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name, description: 'one step', enabled: true, template_mode: false, template: null });
    expect(res.body.connections).toHaveLength(1);
    const c = res.body.connections[0];
    expect(c).toMatchObject({ connection_name: `${name} SMPP 1`, priority: 1, weight: 100, enabled: true, created: true });
    expect(c.connection).toMatchObject({ host: '10.20.30.40', port: 2775, bind_type: 'TX', max_tps: 20, use_tls: false, sessions: 1, request_dlr: true, has_password: true });
    expect(JSON.stringify(res.body)).not.toMatch(/S3cr3t|password_enc|v1:/);

    const row = await ctx.db.selectFrom('upstream_connections').select('password_enc').where('id', '=', c.connection_id).executeTakeFirstOrThrow();
    expect(new CryptoService(loadConfig()).decrypt(row.password_enc)).toBe('S3cr3t!');
    const rates = await ctx.db.selectFrom('upstream_rates').select(['prefix', 'cost_micros']).where('connection_id', '=', c.connection_id).execute();
    expect(rates).toEqual([{ prefix: '', cost_micros: 2500 }]);
    const links = await ctx.db.selectFrom('route_connections').selectAll().where('route_id', '=', res.body.id).execute();
    expect(links).toHaveLength(1);

    const got = await as(ctx, admin).get(`/api/routes/${res.body.id}`);
    expect(got.body.connections[0]).toMatchObject({ connection_id: c.connection_id, host: '10.20.30.40', port: 2775 });
    expect(JSON.stringify(got.body)).not.toMatch(/S3cr3t|password_enc/);

    await waitFor(() =>
      ['upstream_connections', 'upstream_rates', 'routes', 'route_connections'].every((e) => ctx.invalidations.some((m) => m.entity === e)),
    );
    expect(ctx.invalidations).toEqual(
      expect.arrayContaining([
        { entity: 'upstream_connections', id: c.connection_id },
        { entity: 'routes', id: res.body.id },
        { entity: 'route_connections', id: null },
        { entity: 'upstream_rates', id: null },
      ]),
    );
    const audits = await ctx.db.selectFrom('audit_logs').select(['action', 'before', 'after']).where('entity_id', 'in', [res.body.id, c.connection_id]).execute();
    expect(audits.map((a) => a.action).sort()).toEqual(['connection.create', 'connection.rates_replace', 'route.connections_replace', 'route.create']);
    expect(JSON.stringify(audits)).not.toMatch(/S3cr3t|password_enc|v1:/);
  });

  it('mixes an existing connection with a new one; priorities follow row order', async () => {
    const name = uniq('Mixed');
    const res = await as(ctx, admin).post('/api/routes/quick', {
      name,
      connections: [smpp({ name: uniq('primary') }), { existing_connection_id: existingId, priority: 2, weight: 50 }, smpp({ host: 'smsc-b.example.org' })],
    });
    expect(res.status).toBe(201);
    expect(res.body.connections.map((c: { priority: number; created: boolean }) => [c.priority, c.created])).toEqual([
      [1, true],
      [2, false],
      [3, true],
    ]);
    expect(res.body.connections[1]).toMatchObject({ connection_id: existingId, weight: 50 });
    expect(res.body.connections[2].connection_name).toBe(`${name} SMPP 3`);
    const unknown = await as(ctx, admin).post('/api/routes/quick', {
      name: uniq('x'),
      connections: [{ existing_connection_id: '00000000-0000-4000-8000-000000000000' }],
    });
    expect(unknown.status).toBe(400);
  });

  it('template mode: requires a template_body with {otp}; creates the route-wide template', async () => {
    const base = { name: uniq('OTP'), template_mode: true, connections: [{ existing_connection_id: existingId }] };
    const missing = await as(ctx, admin).post('/api/routes/quick', base);
    expect(missing.status).toBe(400);
    expect(missing.body.details.field).toBe('template_body');
    const noOtp = await as(ctx, admin).post('/api/routes/quick', { ...base, template_body: 'Your code' });
    expect(noOtp.status).toBe(400);
    expect(noOtp.body.message).toMatch(/\{otp\}/);
    const noDefault = await as(ctx, admin).post('/api/routes/quick', { ...base, template_body: 'Code {otp}', template_fallback: 'SEND_DEFAULT_TEMPLATE' });
    expect(noDefault.status).toBe(400);
    const ok = await as(ctx, admin).post('/api/routes/quick', { ...base, template_body: 'Your {brand} code is {otp}', template_fallback: 'REJECT' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ template_mode: true, template_fallback: 'REJECT' });
    expect(ok.body.template).toMatchObject({ route_id: ok.body.id, org_id: null, template_body: 'Your {brand} code is {otp}', is_active: true });
    await waitFor(() => ctx.invalidations.some((m) => m.entity === 'route_templates' && m.id === ok.body.template.id));
    const off = await as(ctx, admin).post('/api/routes/quick', { ...base, template_mode: false, template_body: 'x {otp}' });
    expect(off.status).toBe(400);
  });

  it('validates SMPP fields with clear messages', async () => {
    const post = (c: Record<string, unknown>) => as(ctx, admin).post('/api/routes/quick', { name: uniq('v'), connections: [c] });
    const pw = await post(smpp({ password: '123456789' }));
    expect(pw.status).toBe(400);
    expect(pw.body.details.issues).toEqual([expect.objectContaining({ path: 'connections.0.password', message: 'SMPP 3.4 passwords are at most 8 characters' })]);
    const sys = await post(smpp({ system_id: 'a'.repeat(16) }));
    expect(sys.body.details.issues[0].path).toBe('connections.0.system_id');
    const port = await post(smpp({ port: 70000 }));
    expect(port.body.details.issues[0]).toMatchObject({ path: 'connections.0.port', message: 'port must be 1-65535' });
    for (const host of ['bad host', 'smsc_.example', '999.1.1.1', '-x.com', '']) {
      const h = await post(smpp({ host }));
      expect(h.status).toBe(400);
      expect(h.body.details.issues[0].path).toBe('connections.0.host');
    }
    for (const host of ['smsc.example.net', '192.168.1.10', '::1', '[2001:db8::1]', 'localhost']) {
      const h = await post(smpp({ host, password: '123456789' }));
      expect(h.body.details.issues.map((i: { path: string }) => i.path)).toEqual(['connections.0.password']);
    }
    const http = await post({ type: 'HTTP', url: 'https://x' });
    expect(http.body.details.issues[0]).toMatchObject({ path: 'connections.0.type', message: 'HTTP API connections are not supported yet' });
    const none = await as(ctx, admin).post('/api/routes/quick', { name: uniq('v'), connections: [] });
    expect(none.status).toBe(400);
    const extra = await post(smpp({ password_enc: 'x' }));
    expect(extra.status).toBe(400);
  });

  it('non-admins get 403', async () => {
    const r = await as(ctx, reseller).post('/api/routes/quick', { name: uniq('r'), connections: [smpp()] });
    expect(r.status).toBe(403);
    const anyRoute = await ctx.db.selectFrom('routes').select('id').executeTakeFirstOrThrow();
    expect((await as(ctx, reseller).get(`/api/routes/${anyRoute.id}/status`)).status).toBe(403);
  });

  it('duplicate route name → 409 and the new connections are rolled back', async () => {
    const name = uniq('Dup');
    expect((await as(ctx, admin).post('/api/routes', { name })).status).toBe(201);
    const connName = uniq('orphan');
    const before = await ctx.db.selectFrom('upstream_connections').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
    const res = await as(ctx, admin).post('/api/routes/quick', { name, connections: [smpp({ name: connName, cost_micros: 1 })] });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error_code: 'CONFLICT', details: { field: 'name' } });
    expect(res.body.message).toContain(name);
    expect(await ctx.db.selectFrom('upstream_connections').select('id').where('name', '=', connName).execute()).toEqual([]);
    const after = await ctx.db.selectFrom('upstream_connections').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
    expect(Number(after.n)).toBe(Number(before.n));

    // A later row conflicting (same SMSC endpoint as an existing connection) → 409 pointing at
    // that row, and the earlier rows' connections + rate are rolled back (no orphans).
    const firstName = uniq('first');
    const epName = uniq('Ep');
    const ep = await as(ctx, admin).post('/api/routes/quick', {
      name: epName,
      connections: [smpp({ name: firstName, cost_micros: 5 }), smpp({ host: 'smsc.example.net', port: 2775, system_id: 'exist' })],
    });
    expect(ep.status).toBe(409);
    expect(ep.body.details.field).toBe('connections.1.host');
    expect(ep.body.message).toMatch(/smsc\.example\.net:2775/);
    expect(await ctx.db.selectFrom('upstream_connections').select('id').where('name', '=', firstName).execute()).toEqual([]);
    expect(await ctx.db.selectFrom('routes').select('id').where('name', '=', epName).execute()).toEqual([]);
    const final = await ctx.db.selectFrom('upstream_connections').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
    expect(Number(final.n)).toBe(Number(before.n));
    const orphanRates = await ctx.db
      .selectFrom('upstream_rates as r')
      .leftJoin('upstream_connections as c', 'c.id', 'r.connection_id')
      .select('r.id')
      .where('c.id', 'is', null)
      .execute();
    expect(orphanRates).toEqual([]);
  });

  it('GET /api/routes/:id/status merges the engine status per connection', async () => {
    const res = await as(ctx, admin).post('/api/routes/quick', {
      name: uniq('Live'),
      connections: [smpp(), smpp({ host: 'down.example.net' }), { existing_connection_id: existingId }],
    });
    const [a, b, c] = res.body.connections.map((x: { connection_id: string }) => x.connection_id);
    ctx.engine.connections = [
      {
        connection_id: a,
        name: 'a',
        enabled: true,
        state: 'BOUND',
        sessions: [{ index: 0, state: 'BOUND_TRX', bound_since: '2026-01-01T00:00:00Z', last_error: null }],
        tps_limit: 50,
        tps_current: 1.5,
        inflight: 0,
        queue_depth: 0,
        submitted_total: 3,
        failed_total: 0,
      },
      {
        connection_id: b,
        name: 'b',
        enabled: true,
        state: 'DOWN',
        sessions: [{ index: 0, state: 'DOWN', bound_since: null, last_error: 'smpp client: bind rejected: ESME_RINVPASWD' }],
        tps_limit: 50,
        tps_current: 0,
        inflight: 0,
        queue_depth: 0,
        submitted_total: 0,
        failed_total: 0,
      },
    ];
    const st = await as(ctx, admin).get(`/api/routes/${res.body.id}/status`);
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ route_id: res.body.id, engine_reachable: true });
    const by = Object.fromEntries(st.body.connections.map((x: { connection_id: string }) => [x.connection_id, x]));
    expect(by[a]).toMatchObject({ state: 'BOUND', bound_since: '2026-01-01T00:00:00Z', sessions_bound: 1, sessions_total: 1, last_error: null, tps_current: 1.5 });
    expect(by[b]).toMatchObject({ state: 'DOWN', last_error: 'smpp client: bind rejected: ESME_RINVPASWD', sessions_bound: 0 });
    expect(by[c]).toMatchObject({ state: 'UNKNOWN', last_error: null });
    expect(JSON.stringify(st.body)).not.toMatch(/password/);

    ctx.engine.down = true;
    try {
      const down = await as(ctx, admin).get(`/api/routes/${res.body.id}/status`);
      expect(down.status).toBe(200);
      expect(down.body.engine_reachable).toBe(false);
      expect(down.body.connections.every((x: { state: string }) => x.state === 'UNKNOWN')).toBe(true);
    } finally {
      ctx.engine.down = false;
    }
    expect((await as(ctx, admin).get('/api/routes/00000000-0000-4000-8000-000000000000/status')).status).toBe(404);
  });
});
