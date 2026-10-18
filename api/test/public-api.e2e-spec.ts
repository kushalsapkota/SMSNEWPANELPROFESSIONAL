import { Session, TestCtx, adminLogin, as, createApiKey, createChild, insertMessage, setup, uniq } from './helpers';

/** CONTRACTS §11 public API, engine mocked. Rate limit lowered to 20/s for this file. */
describe('public /v1 API', () => {
  let ctx: TestCtx;
  let admin: Session;
  let reseller: Session;
  let client: Session;
  let other: Session;
  let key: string;

  beforeAll(async () => {
    ctx = await setup({ env: () => ({ PUBLIC_API_RATE_LIMIT: '20', API_KEY_TOUCH_INTERVAL_MS: '60000' }) });
    admin = await adminLogin(ctx);
    reseller = await createChild(ctx, admin, uniq('v1-r'));
    client = await createChild(ctx, reseller, uniq('v1-c'));
    other = await createChild(ctx, reseller, uniq('v1-o'));
    key = (await createApiKey(ctx, client)).key;
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(() => ctx.engine.reset());

  const v1 = (k: string) => ({
    get: (url: string) => ctx.http().get(url).set('Authorization', `Bearer ${k}`),
    post: (url: string, body: unknown) => ctx.http().post(url).set('Authorization', `Bearer ${k}`).send(body as object),
  });

  describe('authentication', () => {
    it('401 without a key, with a malformed key, and with an unknown key', async () => {
      const none = await ctx.http().get('/v1/balance');
      expect(none.status).toBe(401);
      expect(none.body.error_code).toBe('UNAUTHORIZED');
      expect((await v1('sk_live_short').get('/v1/balance')).status).toBe(401);
      const unknown = await v1('sk_live_' + 'A'.repeat(40)).get('/v1/balance');
      expect(unknown.status).toBe(401);
      expect(unknown.body.message).toMatch(/invalid api key/i);
    });

    it('a panel JWT is not an API key', async () => {
      const res = await ctx.http().get('/v1/balance').set('Authorization', `Bearer ${client.token}`);
      expect(res.status).toBe(401);
    });

    it('accepts Bearer, X-API-Key and ?api_key= on GET only', async () => {
      expect((await v1(key).get('/v1/balance')).status).toBe(200);
      expect((await ctx.http().get('/v1/balance').set('X-API-Key', key)).status).toBe(200);
      expect((await ctx.http().get(`/v1/balance?api_key=${key}`)).status).toBe(200);
      const post = await ctx.http().post(`/v1/sms/send?api_key=${key}`).send({ to: '919876543210', from: 'ACME', text: 'x' });
      expect(post.status).toBe(401);
      expect(ctx.engine.calls('/internal/v1/submit')).toHaveLength(0);
    });

    it('revoked and expired keys are 401', async () => {
      const k = await createApiKey(ctx, client, { name: 'to-revoke' });
      expect((await v1(k.key).get('/v1/balance')).status).toBe(200);
      expect((await as(ctx, client).delete(`/api/api-keys/${k.id}`)).status).toBe(200);
      const revoked = await v1(k.key).get('/v1/balance');
      expect(revoked.status).toBe(401);
      expect(revoked.body.message).toMatch(/revoked/);

      const e = await createApiKey(ctx, client, { name: 'to-expire' });
      await ctx.db.updateTable('api_keys').set({ expires_at: new Date(Date.now() - 1000) }).where('id', '=', e.id).execute();
      const expired = await v1(e.key).get('/v1/balance');
      expect(expired.status).toBe(401);
      expect(expired.body.message).toMatch(/expired/);
    });

    it('updates last_used_at (throttled)', async () => {
      const k = await createApiKey(ctx, client, { name: 'touch' });
      await v1(k.key).get('/v1/balance').expect(200);
      let seen: Date | null = null;
      const until = Date.now() + 3000;
      while (!seen && Date.now() < until) {
        seen = (await ctx.db.selectFrom('api_keys').select('last_used_at').where('id', '=', k.id).executeTakeFirstOrThrow()).last_used_at;
        if (!seen) await new Promise((r) => setTimeout(r, 25));
      }
      expect(seen).not.toBeNull();
      await v1(k.key).get('/v1/balance').expect(200);
      await new Promise((r) => setTimeout(r, 100));
      const again = (await ctx.db.selectFrom('api_keys').select('last_used_at').where('id', '=', k.id).executeTakeFirstOrThrow()).last_used_at;
      expect(again?.getTime()).toBe(seen?.getTime()); // within the 60s throttle window: no second write
    });

    it('scopes: a read-only key cannot send or read the balance', async () => {
      const k = await createApiKey(ctx, client, { name: 'ro', scopes: ['sms:read'] });
      const send = await v1(k.key).post('/v1/sms/send', { to: '919876543210', from: 'ACME', text: 'x' });
      expect(send.status).toBe(403);
      expect(send.body.error_code).toBe('FORBIDDEN');
      expect((await v1(k.key).get('/v1/balance')).status).toBe(403);
      const bal = await createApiKey(ctx, client, { name: 'bal', scopes: ['balance:read'] });
      expect((await v1(bal.key).get('/v1/balance')).status).toBe(200);
    });
  });

  describe('org state and IP whitelist', () => {
    let c2: Session;
    let k2: string;
    beforeAll(async () => {
      c2 = await createChild(ctx, reseller, uniq('v1-state'));
      k2 = (await createApiKey(ctx, c2)).key;
    });

    it('suspended org → 422 ACCOUNT_SUSPENDED; reactivated → OK', async () => {
      await as(ctx, reseller).post(`/api/orgs/${c2.orgId}/suspend`, { reason: 'unpaid' }).expect(200);
      const res = await v1(k2).post('/v1/sms/send', { to: '919876543210', from: 'ACME', text: 'x' });
      expect(res.status).toBe(422);
      expect(res.body.error_code).toBe('ACCOUNT_SUSPENDED');
      expect(ctx.engine.calls('/internal/v1/submit')).toHaveLength(0);
      await as(ctx, reseller).post(`/api/orgs/${c2.orgId}/activate`).expect(200);
      expect((await v1(k2).get('/v1/balance')).status).toBe(200);
    });

    it('stop sending → SENDING_DISABLED; API off → CHANNEL_DISABLED (also inherited from the reseller)', async () => {
      await as(ctx, reseller).patch(`/api/orgs/${c2.orgId}/channels`, { sending_enabled: false }).expect(200);
      expect((await v1(k2).get('/v1/balance')).body.error_code).toBe('SENDING_DISABLED');
      await as(ctx, reseller).patch(`/api/orgs/${c2.orgId}/channels`, { sending_enabled: true, api_enabled: false }).expect(200);
      const off = await v1(k2).get('/v1/balance');
      expect(off.status).toBe(422);
      expect(off.body.error_code).toBe('CHANNEL_DISABLED');
      await as(ctx, reseller).patch(`/api/orgs/${c2.orgId}/channels`, { api_enabled: true }).expect(200);
      expect((await v1(k2).get('/v1/balance')).status).toBe(200);

      await as(ctx, admin).patch(`/api/orgs/${reseller.orgId}/channels`, { api_enabled: false }).expect(200);
      expect((await v1(k2).get('/v1/balance')).body.error_code).toBe('CHANNEL_DISABLED');
      await as(ctx, admin).patch(`/api/orgs/${reseller.orgId}/channels`, { api_enabled: true }).expect(200);
      expect((await v1(k2).get('/v1/balance')).status).toBe(200);
    });

    it('IP whitelist scope API: blocks other IPs (X-Forwarded-For ignored without TRUST_PROXY), SMPP rules do not apply', async () => {
      const smpp = await as(ctx, c2).post('/api/ip-whitelist', { cidr: '10.9.0.0/16', scope: 'SMPP' }).expect(201);
      expect((await v1(k2).get('/v1/balance')).status).toBe(200);
      const api = await as(ctx, c2).post('/api/ip-whitelist', { cidr: '10.0.0.0/8', scope: 'API' }).expect(201);
      const blocked = await v1(k2).get('/v1/balance').set('X-Forwarded-For', '10.1.2.3');
      expect(blocked.status).toBe(403);
      expect(blocked.body.error_code).toBe('IP_NOT_ALLOWED');
      const local = await as(ctx, c2).post('/api/ip-whitelist', { cidr: '127.0.0.1', scope: 'ALL' }).expect(201);
      expect((await v1(k2).get('/v1/balance')).status).toBe(200);
      for (const id of [smpp.body.id, api.body.id, local.body.id]) await as(ctx, c2).delete(`/api/ip-whitelist/${id}`).expect(200);
    });

    it('rate limit per key (20/s here): excess requests get 429 RATE_LIMITED with Retry-After', async () => {
      const k = (await createApiKey(ctx, c2, { name: 'burst' })).key;
      const results: Awaited<ReturnType<ReturnType<typeof v1>['get']>>[] = [];
      const t0 = Date.now();
      // Sequential: supertest shares one ephemeral listener per app, so concurrent calls race its close().
      for (let i = 0; i < 60; i++) results.push(await v1(k).get('/v1/balance'));
      const windows = Math.floor(Date.now() / 1000) - Math.floor(t0 / 1000) + 1;
      const limited = results.filter((r) => r.status === 429);
      const ok = results.filter((r) => r.status === 200);
      expect(ok.length + limited.length).toBe(60);
      expect(ok.length).toBeLessThanOrEqual(20 * windows); // never more than the limit per 1s window
      expect(limited.length).toBeGreaterThan(0);
      expect(limited[0].body.error_code).toBe('RATE_LIMITED');
      expect(limited[0].headers['retry-after']).toBe('1');
      expect(ok[0].headers['x-ratelimit-limit']).toBe('20');
      // another key of the same org is unaffected
      const fresh = (await createApiKey(ctx, c2, { name: 'calm' })).key;
      expect((await v1(fresh).get('/v1/balance')).status).toBe(200);
    });
  });

  describe('send', () => {
    it('single recipient → /submit (channel HTTP, normalized destination, client_ref)', async () => {
      const res = await v1(key).post('/v1/sms/send', { to: '+91 98765-43210', from: 'ACME', text: 'Your code is 1234', client_ref: 'ref-1' });
      expect(res.status).toBe(200);
      expect(res.body.messages).toHaveLength(1);
      expect(res.body.messages[0]).toEqual({ to: '919876543210', message_id: expect.any(String), status: 'ACCEPTED', parts: 1, cost_micros: 5000 });
      const calls = ctx.engine.calls('/internal/v1/submit');
      expect(calls).toHaveLength(1);
      expect(calls[0].body).toEqual({ org_id: client.orgId, channel: 'HTTP', source: 'ACME', destination: '919876543210', text: 'Your code is 1234', client_ref: 'ref-1' });
    });

    it('single recipient rejected by the engine → engine status + error body', async () => {
      ctx.engine.rejectAll = { status: 422, error_code: 'INSUFFICIENT_FUNDS', message: 'balance too low' };
      const res = await v1(key).post('/v1/sms/send', { to: '919876543210', from: 'ACME', text: 'x' });
      expect(res.status).toBe(422);
      expect(res.body).toEqual({ error_code: 'INSUFFICIENT_FUNDS', message: 'balance too low' });
    });

    it('single invalid destination → 422 INVALID_DESTINATION without calling the engine', async () => {
      const res = await v1(key).post('/v1/sms/send', { to: '12ab', from: 'ACME', text: 'x' });
      expect(res.status).toBe(422);
      expect(res.body.error_code).toBe('INVALID_DESTINATION');
      expect(ctx.engine.requests).toHaveLength(0);
    });

    it('fan-out: one /submit/batch call, one row per recipient in input order', async () => {
      ctx.engine.rejects.set('447700900002', { status: 422, error_code: 'DESTINATION_BLOCKED', message: 'blocked' });
      const to = ['447700900001', 'not-a-number', '+44 7700 900002', '447700900003'];
      const res = await v1(key).post('/v1/sms/send', { to, from: 'ACME', text: 'Hi' });
      expect(res.status).toBe(200);
      expect(res.body.messages).toEqual([
        { to: '447700900001', message_id: expect.any(String), status: 'ACCEPTED', parts: 1, cost_micros: 5000 },
        { to: 'not-a-number', error_code: 'INVALID_DESTINATION', message: expect.any(String) },
        { to: '447700900002', error_code: 'DESTINATION_BLOCKED', message: 'blocked' },
        { to: '447700900003', message_id: expect.any(String), status: 'ACCEPTED', parts: 1, cost_micros: 5000 },
      ]);
      const batch = ctx.engine.calls('/internal/v1/submit/batch');
      expect(batch).toHaveLength(1);
      expect((batch[0].body as { items: { destination: string; channel: string }[] }).items.map((i) => i.destination)).toEqual([
        '447700900001',
        '447700900002',
        '447700900003',
      ]);
      expect(ctx.engine.calls('/internal/v1/submit')).toHaveLength(0);
    });

    it('1000 recipients is one batch; 1001 is 400', async () => {
      const many = Array.from({ length: 1000 }, (_, i) => `4477009${String(i).padStart(5, '0')}`);
      const ok = await v1(key).post('/v1/sms/send', { to: many, from: 'ACME', text: 'Hi' });
      expect(ok.status).toBe(200);
      expect(ok.body.messages).toHaveLength(1000);
      expect(ctx.engine.calls('/internal/v1/submit/batch')).toHaveLength(1);
      const tooMany = await v1(key).post('/v1/sms/send', { to: [...many, '447700999999'], from: 'ACME', text: 'Hi' });
      expect(tooMany.status).toBe(400);
      expect(tooMany.body.error_code).toBe('INVALID_REQUEST');
    });

    it('legacy GET send with ?api_key and comma-separated recipients', async () => {
      const res = await ctx.http().get('/v1/sms/send').query({ api_key: key, to: '447700900001,447700900002', from: 'ACME', text: 'Hi there', client_ref: 'g1' });
      expect(res.status).toBe(200);
      expect(res.body.messages).toHaveLength(2);
      const items = (ctx.engine.calls('/internal/v1/submit/batch')[0].body as { items: { client_ref: string }[] }).items;
      expect(items.every((i) => i.client_ref === 'g1')).toBe(true);
    });

    it('validation errors are 400 with details', async () => {
      const res = await v1(key).post('/v1/sms/send', { to: '919876543210', text: '' });
      expect(res.status).toBe(400);
      expect(res.body.details.issues.map((i: { path: string }) => i.path).sort()).toEqual(['from', 'text']);
    });

    it('engine down → 502', async () => {
      ctx.engine.down = true;
      const res = await v1(key).post('/v1/sms/send', { to: '919876543210', from: 'ACME', text: 'x' });
      expect(res.status).toBe(502);
      expect(res.body.error_code).toBe('INTERNAL');
    });
  });

  describe('message status and balance', () => {
    it('GET /v1/sms/:id returns own messages only', async () => {
      const created = new Date(Date.now() - 60_000);
      const id = await insertMessage(ctx, {
        org_id: client.orgId,
        reseller_id: reseller.orgId,
        destination_addr: '919876543210',
        source_addr: 'ACME',
        status: 'DELIVERED',
        dlr_stat: 'DELIVRD',
        parts: 2,
        client_cost_micros: 10_000,
        reseller_cost_micros: 6000,
        client_msg_ref: 'my-ref',
        created_at: created,
        submitted_at: new Date(created.getTime() + 500),
        dlr_received_at: new Date(created.getTime() + 4000),
      });
      const res = await v1(key).get(`/v1/sms/${id}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        message_id: id,
        to: '919876543210',
        from: 'ACME',
        status: 'DELIVERED',
        dlr_stat: 'DELIVRD',
        parts: 2,
        cost_micros: 10_000,
        created_at: created.toISOString(),
        submitted_at: new Date(created.getTime() + 500).toISOString(),
        done_at: new Date(created.getTime() + 4000).toISOString(),
        client_ref: 'my-ref',
      });

      const foreign = await insertMessage(ctx, { org_id: other.orgId, reseller_id: reseller.orgId });
      expect((await v1(key).get(`/v1/sms/${foreign}`)).status).toBe(404);
      // a reseller key sees only the reseller's own sends on /v1, not its clients'
      const rKey = (await createApiKey(ctx, reseller)).key;
      expect((await v1(rKey).get(`/v1/sms/${id}`)).status).toBe(404);
      expect((await v1(key).get('/v1/sms/not-a-uuid')).status).toBe(404);
    });

    it('GET /v1/balance: live engine value, DB snapshot when the engine is unreachable', async () => {
      ctx.engine.balances.set(client.orgId, 7_250_000);
      const live = await v1(key).get('/v1/balance');
      expect(live.status).toBe(200);
      expect(live.body).toEqual({ balance_micros: 7_250_000, currency: 'USD' });
      ctx.engine.balances.delete(client.orgId);
      await ctx.db.updateTable('accounts_balance').set({ balance_micros: 1_500_000 }).where('org_id', '=', client.orgId).execute();
      const snap = await v1(key).get('/v1/balance');
      expect(snap.body).toEqual({ balance_micros: 1_500_000, currency: 'USD' });
    });
  });

  it('OpenAPI document covers /api and /v1', async () => {
    const res = await ctx.http().get('/api/docs-json');
    expect(res.status).toBe(200);
    const paths = Object.keys(res.body.paths);
    for (const p of ['/v1/sms/send', '/v1/sms/{message_id}', '/v1/balance', '/api/messages', '/api/orgs', '/api/campaigns', '/api/analytics/summary', '/api/auth/login']) {
      expect(paths).toContain(p);
    }
    expect(res.body.paths['/v1/sms/send'].post.security).toEqual([{ 'bearer-api-key': [] }, { 'x-api-key': [] }]);
    expect(res.body.paths['/api/orgs'].get.security).toEqual([{ 'access-token': [] }]);
    expect(res.body.paths['/api/auth/login'].post.security).toEqual([]);
    expect((await ctx.http().get('/api/docs/')).status).toBe(200);
  });
});
