import { CryptoService } from '../src/crypto/crypto.service';
import { loadConfig } from '../src/config/config';
import { AdapterCatalogue } from '../src/connections/http-adapters';
import { Session, TestCtx, adminLogin, as, createChild, setup, uniq, waitFor } from './helpers';

const BASE = 'https://sms.example.test';
const crypto = () => new CryptoService(loadConfig());

describe('HTTP upstream connections (adapters, credentials, test send, balance, quick route, provider DLR)', () => {
  let ctx: TestCtx;
  let admin: Session;
  let reseller: Session;
  /** Every credential value used below: none may ever appear in a response or an audit row. */
  const secrets: string[] = [];
  const secret = (label: string) => {
    const v = `${label}-${uniq('S3CR3T')}`;
    secrets.push(v);
    return v;
  };
  const expectNoSecrets = (v: unknown) => {
    const s = JSON.stringify(v);
    for (const x of secrets) expect(s).not.toContain(x);
    expect(s).not.toMatch(/http_credentials_enc|password_enc|"v1:/);
  };
  const catalogue = () => ctx.app.get(AdapterCatalogue);
  const credsOf = async (id: string) => {
    const row = await ctx.db.selectFrom('upstream_connections').select('http_credentials_enc').where('id', '=', id).executeTakeFirstOrThrow();
    return JSON.parse(crypto().decrypt(row.http_credentials_enc as string)) as Record<string, string>;
  };
  const auditsOf = (ids: string[]) => ctx.db.selectFrom('audit_logs').select(['action', 'before', 'after']).where('entity_id', 'in', ids).execute();

  beforeAll(async () => {
    ctx = await setup({ env: () => ({ PUBLIC_API_BASE_URL: `${BASE}/`, PROVIDER_DLR_RATE_LIMIT: '20' }) });
    admin = await adminLogin(ctx);
    reseller = await createChild(ctx, admin, uniq('http-r'));
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(() => {
    ctx.engine.reset();
    catalogue().clear();
  });

  describe('GET /api/connections/adapters', () => {
    it('proxies the engine catalogue and caches it', async () => {
      const a = await as(ctx, admin).get('/api/connections/adapters');
      expect(a.status).toBe(200);
      expect(a.body.adapters.map((x: { id: string }) => x.id)).toEqual(['sparrow_v2', 'aakash_v3', 'messengernepal', 'nestsms', 'generic_http']);
      expect(a.body.adapters[1]).toMatchObject({ dlr_mode: 'poll', supports_balance: true, credentials: [expect.objectContaining({ key: 'auth_token', secret: true })] });
      const b = await as(ctx, admin).get('/api/connections/adapters');
      expect(b.status).toBe(200);
      expect(ctx.engine.calls('/internal/v1/adapters')).toHaveLength(1);
    });

    it('engine unreachable → 502 with a clear message', async () => {
      ctx.engine.adaptersDown = true;
      const r = await as(ctx, admin).get('/api/connections/adapters');
      expect(r.status).toBe(502);
      expect(r.body).toMatchObject({ error_code: 'INTERNAL', details: { reason: 'ENGINE_UNAVAILABLE' } });
      expect(r.body.message).toMatch(/adapter catalogue is unavailable/);
    });
  });

  describe('create / get / patch', () => {
    it('creates an HTTP connection: credentials encrypted + write-only, dlr token + callback URL, invalidation, clean audit', async () => {
      const token = secret('aakash');
      ctx.invalidations.length = 0;
      const name = uniq('Aakash');
      const res = await as(ctx, admin).post('/api/connections', {
        kind: 'HTTP',
        name,
        adapter: 'aakash_v3',
        credentials: { auth_token: token },
        settings: { dlr_poll_interval_s: 30 },
        max_tps: 15,
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        kind: 'HTTP',
        adapter: 'aakash_v3',
        name,
        max_tps: 15,
        enabled: true,
        host: null,
        port: null,
        system_id: null,
        has_password: false,
        credentials_set: ['auth_token'],
        settings: { dlr_poll_interval_s: 30 },
      });
      expect(res.body.dlr_callback_path).toMatch(/^\/v1\/provider-dlr\/[A-Za-z0-9_-]{32,}$/);
      expect(res.body.dlr_callback_url).toBe(`${BASE}${res.body.dlr_callback_path}`);
      expect(res.body).not.toHaveProperty('dlr_token');
      expectNoSecrets(res.body);

      expect(await credsOf(res.body.id)).toEqual({ auth_token: token });
      const row = await ctx.db.selectFrom('upstream_connections').selectAll().where('id', '=', res.body.id).executeTakeFirstOrThrow();
      expect(row.http_credentials_enc).toMatch(/^v1:/);
      expect(row.dlr_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(row.http_settings).toEqual({ dlr_poll_interval_s: 30 });

      for (const r of [await as(ctx, admin).get(`/api/connections/${res.body.id}`), await as(ctx, admin).get('/api/connections?kind=HTTP')]) {
        expect(r.status).toBe(200);
        expectNoSecrets(r.body);
      }
      const list = await as(ctx, admin).get(`/api/connections?q=${encodeURIComponent(name)}`);
      expect(list.body.items).toEqual([expect.objectContaining({ id: res.body.id, kind: 'HTTP', adapter: 'aakash_v3' })]);
      const smppOnly = await as(ctx, admin).get('/api/connections?kind=SMPP&page_size=200');
      expect(smppOnly.body.items.every((c: { kind: string }) => c.kind === 'SMPP')).toBe(true);

      await waitFor(() => ctx.invalidations.some((m) => m.entity === 'upstream_connections' && m.id === res.body.id));
      const audits = await auditsOf([res.body.id]);
      expect(audits.map((a) => a.action)).toEqual(['connection.create']);
      expectNoSecrets(audits);
      expect(JSON.stringify(audits)).not.toContain(row.dlr_token as string);
    });

    it('dlr tokens are unique per connection', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 2; i++) {
        const r = await as(ctx, admin).post('/api/connections', { kind: 'HTTP', name: uniq('Sp'), adapter: 'sparrow_v2', credentials: { token: secret('sp') }, settings: { sender: 'InfoSMS' } });
        expect(r.status).toBe(201);
        ids.push(r.body.id);
      }
      const rows = await ctx.db.selectFrom('upstream_connections').select('dlr_token').where('id', 'in', ids).execute();
      expect(new Set(rows.map((r) => r.dlr_token)).size).toBe(2);
    });

    it.each([
      ['unknown adapter', { adapter: 'nope' }, 'adapter'],
      ['missing required credential', { credentials: {} }, 'credentials.auth_token'],
      ['empty required credential', { credentials: { auth_token: '' } }, 'credentials.auth_token'],
      ['unknown credential key', { credentials: { auth_token: 'x', password: 'y' } }, 'credentials.password'],
      ['non-string credential', { credentials: { auth_token: 123 } }, 'credentials.auth_token'],
      ['unknown setting', { settings: { colour: 'red' } }, 'settings.colour'],
      ['setting of the wrong type', { settings: { dlr_poll_interval_s: 'often' } }, 'settings.dlr_poll_interval_s'],
      ['non-http URL setting', { settings: { base_url: 'ftp://files.example.com' } }, 'settings.base_url'],
    ])('400 on %s', async (_label, over, path) => {
      const res = await as(ctx, admin).post('/api/connections', { kind: 'HTTP', name: uniq('bad'), adapter: 'aakash_v3', credentials: { auth_token: 'x' }, ...over });
      expect(res.status).toBe(400);
      expect(res.body.error_code).toBe('INVALID_REQUEST');
      expect(res.body.details.issues.map((i: { path: string }) => i.path)).toContain(path);
    });

    it('400 on required settings (nestsms base_url) and invalid select values (generic_http)', async () => {
      const a = await as(ctx, admin).post('/api/connections', { kind: 'HTTP', name: uniq('nest'), adapter: 'nestsms', credentials: { token: 't' } });
      expect(a.status).toBe(400);
      expect(a.body.details.issues).toEqual([expect.objectContaining({ path: 'settings.base_url', message: expect.stringMatching(/required/) })]);
      const b = await as(ctx, admin).post('/api/connections', {
        kind: 'HTTP',
        name: uniq('gen'),
        adapter: 'generic_http',
        settings: { method: 'PUT', url: 'https://api.example.com/send?to={to}', body_type: 'json', params_template: '{}' },
      });
      expect(b.status).toBe(400);
      expect(b.body.details.issues).toEqual([expect.objectContaining({ path: 'settings.method' })]);
      const c = await as(ctx, admin).post('/api/connections', {
        kind: 'HTTP',
        name: uniq('gen'),
        adapter: 'generic_http',
        credentials: { token: secret('gen') },
        settings: { method: 'GET', url: 'https://api.example.com/send?to={to}&key={token}', body_type: 'query', params_template: '{"msg":"{text}"}', use_tls_verify: false },
      });
      expect(c.status).toBe(201);
      expect(c.body).toMatchObject({ adapter: 'generic_http', credentials_set: ['token'] });
      // SMPP fields are not accepted on the HTTP create body (strict).
      const d = await as(ctx, admin).post('/api/connections', { kind: 'HTTP', name: uniq('x'), adapter: 'aakash_v3', credentials: { auth_token: 'x' }, host: 'h' });
      expect(d.status).toBe(400);
    });

    it('engine catalogue unreachable while validating → 502, nothing written', async () => {
      ctx.engine.adaptersDown = true;
      const name = uniq('down');
      const res = await as(ctx, admin).post('/api/connections', { kind: 'HTTP', name, adapter: 'aakash_v3', credentials: { auth_token: 'x' } });
      expect(res.status).toBe(502);
      expect(res.body.message).toMatch(/Cannot validate the HTTP connection/);
      expect(await ctx.db.selectFrom('upstream_connections').select('id').where('name', '=', name).executeTakeFirst()).toBeUndefined();
    });

    it('PATCH merges credentials (omitted = unchanged, "" = clear) and settings; kind/field mismatches are 400', async () => {
      const tok = secret('mn-token');
      const whs = secret('mn-whsec');
      const c = await as(ctx, admin).post('/api/connections', {
        kind: 'HTTP',
        name: uniq('MN'),
        adapter: 'messengernepal',
        credentials: { token: tok, webhook_secret: whs },
        settings: { sender: 'ACME' },
      });
      expect(c.status).toBe(201);
      expect(c.body.credentials_set).toEqual(['token', 'webhook_secret']);
      const id = c.body.id as string;

      const tok2 = secret('mn-token2');
      const p1 = await as(ctx, admin).patch(`/api/connections/${id}`, { credentials: { token: tok2 }, settings: { max_concurrency: 5 }, max_tps: 7 });
      expect(p1.status).toBe(200);
      expect(p1.body).toMatchObject({ credentials_set: ['token', 'webhook_secret'], settings: { sender: 'ACME', max_concurrency: 5 }, max_tps: 7 });
      expectNoSecrets(p1.body);
      expect(await credsOf(id)).toEqual({ token: tok2, webhook_secret: whs });

      const p2 = await as(ctx, admin).patch(`/api/connections/${id}`, { credentials: { webhook_secret: '' }, settings: { sender: null } });
      expect(p2.status).toBe(200);
      expect(p2.body).toMatchObject({ credentials_set: ['token'], settings: { max_concurrency: 5 } });
      expect(await credsOf(id)).toEqual({ token: tok2 });

      const p3 = await as(ctx, admin).patch(`/api/connections/${id}`, { credentials: { token: '' } });
      expect(p3.status).toBe(400);
      expect(p3.body.details.issues[0].path).toBe('credentials.token');
      expect(await credsOf(id)).toEqual({ token: tok2 });

      // name-only patch does not need (or call) the catalogue
      ctx.engine.adaptersDown = true;
      const p4 = await as(ctx, admin).patch(`/api/connections/${id}`, { name: uniq('MN renamed'), enabled: false });
      expect(p4.status).toBe(200);
      expect(p4.body.enabled).toBe(false);
      catalogue().clear();
      const p5 = await as(ctx, admin).patch(`/api/connections/${id}`, { credentials: { token: 'zzz' } });
      expect(p5.status).toBe(502);
      ctx.engine.adaptersDown = false;

      const bad = await as(ctx, admin).patch(`/api/connections/${id}`, { host: 'smsc.example.com', password: 'x' });
      expect(bad.status).toBe(400);
      expect(bad.body.details.issues.map((i: { path: string }) => i.path).sort()).toEqual(['host', 'password']);
      const kind = await as(ctx, admin).patch(`/api/connections/${id}`, { kind: 'SMPP' });
      expect(kind.status).toBe(400);

      const smpp = await as(ctx, admin).post('/api/connections', { name: uniq('smpp'), host: 'smsc.example.org', port: 2775, system_id: uniq('s').slice(-15), password: 'pw', max_tps: 5 });
      expect(smpp.status).toBe(201);
      expect(smpp.body).toMatchObject({ kind: 'SMPP', adapter: null, credentials_set: [], dlr_callback_url: null, has_password: true });
      const smppBad = await as(ctx, admin).patch(`/api/connections/${smpp.body.id}`, { credentials: { token: 'x' } });
      expect(smppBad.status).toBe(400);
      expect(smppBad.body.details.issues[0].path).toBe('credentials');

      const audits = await auditsOf([id]);
      expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['connection.create', 'connection.update']));
      expectNoSecrets(audits);
      const withChange = audits.find((a) => JSON.stringify(a.after).includes('credentials_changed'));
      expect((withChange?.after as { credentials_changed: string[] }).credentials_changed).toEqual(['token']);
    });
  });

  describe('test send + balance', () => {
    let id: string;
    beforeAll(async () => {
      ctx.engine.reset();
      const r = await as(ctx, admin).post('/api/connections', { kind: 'HTTP', name: uniq('T'), adapter: 'aakash_v3', credentials: { auth_token: secret('t') } });
      id = r.body.id;
    });

    it('POST /:id/test proxies the engine and is audited (destination only)', async () => {
      const r = await as(ctx, admin).post(`/api/connections/${id}/test`, { to: '9800000000', text: 'hello test' });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, provider_message_id: 'prov-123', http_status: 200, request: { method: 'POST' } });
      const call = ctx.engine.calls(`/internal/v1/connections/${id}/test`);
      expect(call).toHaveLength(1);
      expect(call[0].body).toEqual({ to: '9800000000', text: 'hello test' });
      const audits = await ctx.db.selectFrom('audit_logs').select(['action', 'after']).where('entity_id', '=', id).where('action', '=', 'connection.test').execute();
      expect(audits).toHaveLength(1);
      expect(audits[0].after).toMatchObject({ to: '9800000000', ok: true });
    });

    it('test failures come back as 200 {ok:false}; validation, 404 and engine down', async () => {
      ctx.engine.testReply = { ok: false, provider_message_id: null, http_status: 200, request: null, response_body: '{"error":true}', error: 'The provided Auth Token is not valid.', duration_ms: 10 };
      const f = await as(ctx, admin).post(`/api/connections/${id}/test`, { to: '9800000000', text: 'x' });
      expect(f.status).toBe(200);
      expect(f.body).toMatchObject({ ok: false, error: 'The provided Auth Token is not valid.' });
      expect((await as(ctx, admin).post(`/api/connections/${id}/test`, { to: 'abc', text: 'x' })).status).toBe(400);
      expect((await as(ctx, admin).post(`/api/connections/${id}/test`, { to: '9800000000', text: '' })).status).toBe(400);
      expect((await as(ctx, admin).post('/api/connections/00000000-0000-4000-8000-000000000000/test', { to: '9800000000', text: 'x' })).status).toBe(404);
      ctx.engine.down = true;
      expect((await as(ctx, admin).post(`/api/connections/${id}/test`, { to: '9800000000', text: 'x' })).status).toBe(502);
    });

    it('GET /:id/balance proxies the engine', async () => {
      const r = await as(ctx, admin).get(`/api/connections/${id}/balance`);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ supported: true, balance: '1234', raw: '{"available_credit":1234}', error: null });
      expect((await as(ctx, admin).get('/api/connections/00000000-0000-4000-8000-000000000000/balance')).status).toBe(404);
    });

    it('non-admins get 403 on every HTTP connection endpoint', async () => {
      const r = as(ctx, reseller);
      expect((await r.get('/api/connections/adapters')).status).toBe(403);
      expect((await r.post('/api/connections', { kind: 'HTTP', name: 'x', adapter: 'aakash_v3', credentials: { auth_token: 'x' } })).status).toBe(403);
      expect((await r.patch(`/api/connections/${id}`, { credentials: { auth_token: 'y' } })).status).toBe(403);
      expect((await r.post(`/api/connections/${id}/test`, { to: '9800000000', text: 'x' })).status).toBe(403);
      expect((await r.get(`/api/connections/${id}/balance`)).status).toBe(403);
      expect(ctx.engine.calls(`/internal/v1/connections/${id}/test`)).toHaveLength(0);
    });
  });

  describe('quick route with HTTP rows', () => {
    const smpp = () => ({ type: 'SMPP', host: '10.9.8.7', port: 2775, system_id: uniq('q').slice(-15), password: 'pw1' });

    it('creates SMPP + HTTP connections in one transaction; status shows HTTP fields', async () => {
      const tok = secret('quick');
      const name = uniq('QuickHttp');
      const res = await as(ctx, admin).post('/api/routes/quick', {
        name,
        connections: [smpp(), { type: 'HTTP', adapter: 'aakash_v3', credentials: { auth_token: tok }, cost_micros: 900, max_tps: 30 }],
      });
      expect(res.status).toBe(201);
      expectNoSecrets(res.body);
      const [s, h] = res.body.connections;
      expect(s.connection).toMatchObject({ kind: 'SMPP', has_password: true });
      expect(h).toMatchObject({ connection_name: `${name} HTTP 2`, priority: 2, created: true });
      expect(h.connection).toMatchObject({ kind: 'HTTP', adapter: 'aakash_v3', credentials_set: ['auth_token'], max_tps: 30 });
      expect(h.connection.dlr_callback_url).toMatch(new RegExp(`^${BASE}/v1/provider-dlr/`));
      expect(await credsOf(h.connection_id)).toEqual({ auth_token: tok });
      const rates = await ctx.db.selectFrom('upstream_rates').select(['prefix', 'cost_micros']).where('connection_id', '=', h.connection_id).execute();
      expect(rates).toEqual([{ prefix: '', cost_micros: 900 }]);
      expectNoSecrets(await auditsOf([h.connection_id, res.body.id]));

      ctx.engine.connections = [
        {
          connection_id: h.connection_id,
          name: h.connection_name,
          enabled: true,
          kind: 'HTTP',
          adapter: 'aakash_v3',
          state: 'ERROR',
          last_error: 'HTTP 200 error=true: The provided Auth Token is not valid.',
          last_error_at: '2026-10-18T10:00:00Z',
          last_success_at: '2026-10-18T09:00:00Z',
          sessions: [],
          tps_limit: 30,
          tps_current: 0,
          inflight: 0,
          queue_depth: 0,
          submitted_total: 3,
          failed_total: 1,
        },
      ];
      const st = await as(ctx, admin).get(`/api/routes/${res.body.id}/status`);
      expect(st.status).toBe(200);
      const hs = st.body.connections.find((c: { connection_id: string }) => c.connection_id === h.connection_id);
      expect(hs).toMatchObject({
        kind: 'HTTP',
        adapter: 'aakash_v3',
        host: null,
        state: 'ERROR',
        last_error: expect.stringMatching(/Auth Token/),
        last_error_at: '2026-10-18T10:00:00Z',
        last_success_at: '2026-10-18T09:00:00Z',
        sessions_total: 0,
        dlr_callback_url: h.connection.dlr_callback_url,
      });
      expect(hs).not.toHaveProperty('dlr_token');
      const ss = st.body.connections.find((c: { connection_id: string }) => c.connection_id === s.connection_id);
      expect(ss).toMatchObject({ kind: 'SMPP', adapter: null, state: 'UNKNOWN' });
      expectNoSecrets(st.body);
    });

    it('HTTP validation errors are reported per row and nothing is written', async () => {
      const name = uniq('QuickBad');
      const res = await as(ctx, admin).post('/api/routes/quick', {
        name,
        connections: [smpp(), { type: 'HTTP', adapter: 'aakash_v3', credentials: {} }, { type: 'HTTP', adapter: 'nope', credentials: {} }],
      });
      expect(res.status).toBe(400);
      expect(res.body.details.issues.map((i: { path: string }) => i.path)).toEqual(['connections.1.credentials.auth_token', 'connections.2.adapter']);
      expect(await ctx.db.selectFrom('routes').select('id').where('name', '=', name).executeTakeFirst()).toBeUndefined();
      const shape = await as(ctx, admin).post('/api/routes/quick', { name, connections: [{ type: 'HTTP', credentials: {} }] });
      expect(shape.status).toBe(400);
      expect(shape.body.details.issues[0].path).toBe('connections.0.adapter');
      const wrongType = await as(ctx, admin).post('/api/routes/quick', { name, connections: [{ type: 'SOAP' }] });
      expect(wrongType.status).toBe(400);
    });

    it('mixed SMPP + HTTP: a later HTTP row conflict rolls back the SMPP row too', async () => {
      const taken = uniq('TakenName');
      const pre = await as(ctx, admin).post('/api/connections', { kind: 'HTTP', name: taken, adapter: 'sparrow_v2', credentials: { token: 'x' }, settings: { sender: 'S' } });
      expect(pre.status).toBe(201);
      const s = smpp();
      const name = uniq('QuickRollback');
      const res = await as(ctx, admin).post('/api/routes/quick', {
        name,
        connections: [s, { type: 'HTTP', name: taken, adapter: 'aakash_v3', credentials: { auth_token: secret('rb') } }],
      });
      expect(res.status).toBe(409);
      expect(res.body.details.field).toBe('connections.1.name');
      expect(await ctx.db.selectFrom('upstream_connections').select('id').where('system_id', '=', s.system_id).executeTakeFirst()).toBeUndefined();
      expect(await ctx.db.selectFrom('routes').select('id').where('name', '=', name).executeTakeFirst()).toBeUndefined();
      expectNoSecrets(res.body);
    });

    it('engine catalogue unreachable → 502 and nothing written', async () => {
      ctx.engine.adaptersDown = true;
      const name = uniq('QuickDown');
      const res = await as(ctx, admin).post('/api/routes/quick', { name, connections: [{ type: 'HTTP', adapter: 'aakash_v3', credentials: { auth_token: 'x' } }] });
      expect(res.status).toBe(502);
      expect(await ctx.db.selectFrom('routes').select('id').where('name', '=', name).executeTakeFirst()).toBeUndefined();
    });
  });

  describe('public provider DLR callback /v1/provider-dlr/:token', () => {
    let token: string;
    let path: string;
    beforeAll(async () => {
      ctx.engine.reset();
      const c = await as(ctx, admin).post('/api/connections', { kind: 'HTTP', name: uniq('CB'), adapter: 'messengernepal', credentials: { token: secret('cb') } });
      path = c.body.dlr_callback_path;
      token = path.split('/').pop() as string;
    });
    const forwarded = () => ctx.engine.requests.filter((r) => r.path.startsWith('/internal/v1/provider-dlr/'));

    it('POST: forwards method, query, lowercased headers and the raw body (base64), answers 200 OK', async () => {
      const raw = '{"id":"evt_1","type":"sms.delivered","data":{"message_id":"m1","status":"delivered"}}';
      const res = await ctx
        .http()
        .post(`${path}?a=1&a=2&b=x`)
        .set('Content-Type', 'application/json')
        .set('X-Msngr-Signature', 'sha256=abc')
        .set('Cookie', 'sid=1')
        .send(raw);
      expect(res.status).toBe(200);
      expect(res.text).toBe('OK');
      const f = forwarded();
      expect(f).toHaveLength(1);
      expect(f[0].path).toBe(`/internal/v1/provider-dlr/${token}`);
      expect(f[0].token).toBe(process.env.INTERNAL_TOKEN);
      const env = f[0].body as { method: string; query: Record<string, unknown>; headers: Record<string, string>; body_base64: string };
      expect(env.method).toBe('POST');
      expect(env.query).toEqual({ a: ['1', '2'], b: 'x' });
      expect(env.headers['x-msngr-signature']).toBe('sha256=abc');
      expect(env.headers['content-type']).toBe('application/json');
      expect(env.headers).not.toHaveProperty('cookie');
      expect(Buffer.from(env.body_base64, 'base64').toString('utf8')).toBe(raw);
    });

    it('GET and form bodies are forwarded verbatim too', async () => {
      const g = await ctx.http().get(`${path}?messageId=42&status=DELIVERED`);
      expect(g.status).toBe(200);
      expect(g.text).toBe('OK');
      const form = await ctx.http().post(path).set('Content-Type', 'application/x-www-form-urlencoded').send('id=42&status=delivered&x=%20y');
      expect(form.status).toBe(200);
      const [ge, fe] = forwarded().map((r) => r.body as { method: string; query: Record<string, unknown>; body_base64: string });
      expect(ge).toMatchObject({ method: 'GET', query: { messageId: '42', status: 'DELIVERED' }, body_base64: '' });
      expect(Buffer.from(fe.body_base64, 'base64').toString('utf8')).toBe('id=42&status=delivered&x=%20y');
    });

    it('unknown / malformed tokens get 200 OK and are not forwarded', async () => {
      for (const t of ['A'.repeat(43), 'short', 'bad*token*' + 'x'.repeat(40)]) {
        const r = await ctx.http().post(`/v1/provider-dlr/${t}`).send({ a: 1 });
        expect(r.status).toBe(200);
        expect(r.text).toBe('OK');
      }
      expect(forwarded()).toHaveLength(0);
    });

    it('engine says unknown (404) → 200; engine down → 503 so the provider retries', async () => {
      ctx.engine.dlrTokens = new Set();
      expect((await ctx.http().post(path).send({ a: 1 })).status).toBe(200);
      ctx.engine.dlrTokens = null;
      ctx.engine.down = true;
      const r = await ctx.http().post(path).send({ a: 1 });
      expect(r.status).toBe(503);
      expect(r.text).not.toContain(token);
    });

    it('bodies over 64KB are refused with 413 and not forwarded', async () => {
      const r = await ctx.http().post(path).set('Content-Type', 'text/plain').send('x'.repeat(64 * 1024 + 1));
      expect(r.status).toBe(413);
      expect(forwarded()).toHaveLength(0);
      const ok = await ctx.http().post(path).set('Content-Type', 'text/plain').send('x'.repeat(60 * 1024));
      expect(ok.status).toBe(200);
    });

    it('is rate limited per token (429)', async () => {
      // Align to the start of a 1s window so all requests land in the same one.
      await new Promise((r) => setTimeout(r, 1000 - (Date.now() % 1000) + 5));
      const statuses: number[] = [];
      for (let i = 0; i < 30; i++) statuses.push((await ctx.http().post(path).send({ a: 1 })).status);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
      expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(20);
    });

    it('needs no auth and never appears in audit logs', async () => {
      const audits = await ctx.db.selectFrom('audit_logs').select(['before', 'after']).execute();
      expect(JSON.stringify(audits)).not.toContain(token);
    });
  });
});
