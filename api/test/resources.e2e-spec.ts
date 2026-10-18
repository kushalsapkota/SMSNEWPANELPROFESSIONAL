import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { verify as argonVerify } from '@node-rs/argon2';
import { Session, TestCtx, adminLogin, as, createChild, setup, uniq, waitFor } from './helpers';

describe('scoped resources', () => {
  let ctx: TestCtx;
  let admin: Session;
  let reseller: Session;
  let client: Session;

  beforeAll(async () => {
    ctx = await setup();
    admin = await adminLogin(ctx);
    reseller = await createChild(ctx, admin, uniq('res-r'));
    client = await createChild(ctx, reseller, uniq('res-c'));
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(() => ctx.engine.reset());

  describe('api keys', () => {
    it('returns the key once; stores only sha256; revoke', async () => {
      const res = await as(ctx, client).post('/api/api-keys', { name: 'prod' });
      expect(res.status).toBe(201);
      expect(res.body.key).toMatch(/^sk_live_[A-Za-z0-9]{40}$/);
      expect(res.body.key_prefix).toBe(res.body.key.slice(0, 12));
      expect(res.body.scopes).toEqual(['sms:send', 'sms:read']);
      const row = await ctx.db.selectFrom('api_keys').select(['key_hash', 'key_prefix']).where('id', '=', res.body.id).executeTakeFirstOrThrow();
      expect(row.key_hash.equals(createHash('sha256').update(res.body.key).digest())).toBe(true);

      const list = await as(ctx, client).get('/api/api-keys');
      expect(list.body.items[0].key).toBeUndefined();
      expect(list.body.items[0].key_hash).toBeUndefined();
      const del = await as(ctx, client).delete(`/api/api-keys/${res.body.id}`);
      expect(del.status).toBe(200);
      expect(del.body.revoked_at).not.toBeNull();
      expect((await as(ctx, client).get('/api/api-keys')).body.items.find((k: { id: string }) => k.id === res.body.id)).toBeUndefined();
      expect((await as(ctx, client).get('/api/api-keys?include_revoked=true')).body.items.find((k: { id: string }) => k.id === res.body.id)).toBeDefined();
      expect((await as(ctx, client).post('/api/api-keys', { name: 'x', expires_at: '2000-01-01T00:00:00Z' })).status).toBe(400);
      expect((await as(ctx, admin).post('/api/api-keys', { name: 'admin' })).status).toBe(400);
      expect((await as(ctx, reseller).post(`/api/api-keys?org_id=${client.orgId}`, { name: 'by-parent' })).status).toBe(201);
    });
  });

  describe('sender ids', () => {
    it('client requests (PENDING), parent approves / rejects, parent-created is APPROVED', async () => {
      const req = await as(ctx, client).post('/api/sender-ids', { sender: 'MYBANK' });
      expect(req.status).toBe(201);
      expect(req.body.status).toBe('PENDING');
      expect((await as(ctx, client).post('/api/sender-ids', { sender: 'MYBANK' })).status).toBe(409);
      expect((await as(ctx, client).post('/api/sender-ids', { sender: 'WAY-TOO-LONG-SENDER' })).status).toBe(400);
      expect((await as(ctx, client).post(`/api/sender-ids/${req.body.id}/approve`)).status).toBe(403);
      expect((await as(ctx, admin).post(`/api/sender-ids/${req.body.id}/approve`)).status).toBe(403);

      const queue = await as(ctx, reseller).get('/api/sender-ids?include_children=true&status=PENDING');
      expect(queue.body.items.map((s: { id: string }) => s.id)).toContain(req.body.id);
      const ok = await as(ctx, reseller).post(`/api/sender-ids/${req.body.id}/approve`);
      expect(ok.body).toMatchObject({ status: 'APPROVED', reviewed_by: reseller.userId });
      const numeric = await as(ctx, client).post('/api/sender-ids', { sender: '+447700900123' });
      expect(numeric.body.sender).toBe('447700900123');
      const rej = await as(ctx, reseller).post(`/api/sender-ids/${numeric.body.id}/reject`);
      expect(rej.body.status).toBe('REJECTED');
      const direct = await as(ctx, reseller).post(`/api/sender-ids?org_id=${client.orgId}`, { sender: 'ACME' });
      expect(direct.body.status).toBe('APPROVED');
      const rs = await as(ctx, reseller).post('/api/sender-ids', { sender: 'RESELL' });
      expect(rs.body.status).toBe('PENDING');
      expect((await as(ctx, admin).post(`/api/sender-ids/${rs.body.id}/approve`)).body.status).toBe('APPROVED');
      await waitFor(() => ctx.invalidations.some((m) => m.entity === 'sender_ids' && m.id === rs.body.id));
      expect((await as(ctx, client).delete(`/api/sender-ids/${req.body.id}`)).status).toBe(200);
    });
  });

  describe('smpp accounts', () => {
    it('password ≤ 8 chars hashed with argon2id; rotate/disable/delete kick sessions; hash never returned', async () => {
      const systemId = uniq('sys').replace(/[^A-Za-z0-9]/g, '').slice(-15);
      expect((await as(ctx, client).post('/api/smpp-accounts', { system_id: systemId, password: '123456789' })).status).toBe(400);
      const res = await as(ctx, client).post('/api/smpp-accounts', { system_id: systemId, password: 'abc12345', allowed_bind_types: ['TRX'], max_tps: 20 });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ system_id: systemId, allowed_bind_types: ['TRX'], max_tps: 20, max_binds: 2, enabled: true });
      expect(res.body.password_hash).toBeUndefined();
      const row = await ctx.db.selectFrom('smpp_accounts').select('password_hash').where('id', '=', res.body.id).executeTakeFirstOrThrow();
      expect(row.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      expect(await argonVerify(row.password_hash, 'abc12345')).toBe(true);
      expect((await as(ctx, reseller).post(`/api/smpp-accounts?org_id=${client.orgId}`, { system_id: systemId, password: 'x' })).status).toBe(409);

      const list = await as(ctx, client).get('/api/smpp-accounts');
      expect(list.body.items[0].allowed_bind_types).toEqual(['TRX']);

      const rot = await as(ctx, client).post(`/api/smpp-accounts/${res.body.id}/password`, { password: 'newpass1' });
      expect(rot.status).toBe(200);
      expect(await argonVerify((await ctx.db.selectFrom('smpp_accounts').select('password_hash').where('id', '=', res.body.id).executeTakeFirstOrThrow()).password_hash, 'newpass1')).toBe(true);
      expect(ctx.engine.calls('/internal/v1/smpp/sessions/kick').map((c) => c.body)).toEqual([{ org_id: client.orgId }]);

      const patch = await as(ctx, reseller).patch(`/api/smpp-accounts/${res.body.id}`, { enabled: false, allowed_bind_types: ['TX', 'RX'], max_tps: null });
      expect(patch.body).toMatchObject({ enabled: false, allowed_bind_types: ['TX', 'RX'], max_tps: null });
      expect(ctx.engine.calls('/internal/v1/smpp/sessions/kick')).toHaveLength(2);
      expect((await as(ctx, client).delete(`/api/smpp-accounts/${res.body.id}`)).status).toBe(200);
      expect(ctx.engine.calls('/internal/v1/smpp/sessions/kick')).toHaveLength(3);
      await waitFor(() => ctx.invalidations.filter((m) => m.entity === 'smpp_accounts' && m.id === res.body.id).length >= 4);
      const audits = await ctx.db.selectFrom('audit_logs').select(['action', 'before', 'after']).where('entity_id', '=', res.body.id).execute();
      expect(audits.map((a) => a.action).sort()).toEqual(['smpp_account.create', 'smpp_account.delete', 'smpp_account.password_rotate', 'smpp_account.update']);
      expect(JSON.stringify(audits)).not.toMatch(/argon2|abc12345|newpass1/);
    });
  });

  describe('ip whitelist', () => {
    it('validates CIDRs, normalizes bare IPs, prevents panel self-lockout', async () => {
      const c = as(ctx, client);
      const bad = await c.post('/api/ip-whitelist', { cidr: '10.0.0.5/24', scope: 'API' });
      expect(bad.status).toBe(400);
      expect(bad.body.message).toMatch(/10\.0\.0\.0\/24/);
      expect((await c.post('/api/ip-whitelist', { cidr: '300.1.1.1' })).status).toBe(400);
      expect((await c.post('/api/ip-whitelist', { cidr: '10.0.0.0/33' })).status).toBe(400);
      const ok = await c.post('/api/ip-whitelist', { cidr: '203.0.113.7', scope: 'API', note: 'office' });
      expect(ok.status).toBe(201);
      expect(ok.body.cidr).toBe('203.0.113.7/32');
      const v6 = await c.post('/api/ip-whitelist', { cidr: '2001:db8::/32', scope: 'SMPP' });
      expect(v6.body.cidr).toBe('2001:db8::/32');
      expect((await c.post('/api/ip-whitelist', { cidr: '203.0.113.7/32', scope: 'API' })).status).toBe(409);
      const lock = await c.post('/api/ip-whitelist', { cidr: '198.51.100.0/24', scope: 'PANEL' });
      expect(lock.status).toBe(400);
      expect(lock.body.details.current_ip).toBe('127.0.0.1');
      expect((await c.post('/api/ip-whitelist', { cidr: '127.0.0.0/8', scope: 'PANEL' })).status).toBe(201);
      expect((await c.get('/api/ip-whitelist?scope=API')).body.total).toBe(1);
      expect((await c.delete(`/api/ip-whitelist/${ok.body.id}`)).status).toBe(200);
      await waitFor(() => ctx.invalidations.some((m) => m.entity === 'ip_whitelists' && m.id === ok.body.id));
    });
  });

  describe('webhooks', () => {
    let server: http.Server;
    let received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
    let url = '';
    let respondWith = 200;
    beforeAll(async () => {
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          received.push({ headers: req.headers, body });
          res.writeHead(respondWith, { 'Content-Type': 'text/plain' });
          res.end('thanks');
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dlr`;
    });
    afterAll(async () => {
      await new Promise<void>((r) => server.close(() => r()));
    });

    it('secret is generated, encrypted, returned once; test sends a correctly signed DLR and logs it', async () => {
      const res = await as(ctx, client).post('/api/webhooks', { url });
      expect(res.status).toBe(201);
      const secret: string = res.body.secret;
      expect(secret).toMatch(/^whsec_/);
      expect(res.body.secret_enc).toBeUndefined();
      const row = await ctx.db.selectFrom('webhooks').select('secret_enc').where('id', '=', res.body.id).executeTakeFirstOrThrow();
      expect(row.secret_enc).toMatch(/^v1:/);
      expect((await as(ctx, client).get('/api/webhooks')).body.items[0].secret).toBeUndefined();

      received = [];
      const t = await as(ctx, client).post(`/api/webhooks/${res.body.id}/test`);
      expect(t.status).toBe(200);
      expect(t.body).toMatchObject({ ok: true, status_code: 200, error: null, response_body: 'thanks' });
      expect(received).toHaveLength(1);
      const { headers, body } = received[0];
      const ts = headers['x-webhook-timestamp'] as string;
      expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(10);
      expect(headers['x-webhook-signature']).toBe(`sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`);
      expect(JSON.parse(body)).toMatchObject({ event: 'dlr', status: 'DELIVERED', dlr_stat: 'DELIVRD', dlr_err: '000', parts: 1, test: true });

      respondWith = 500;
      const fail = await as(ctx, client).post(`/api/webhooks/${res.body.id}/test`);
      expect(fail.body).toMatchObject({ ok: false, status_code: 500, error: 'HTTP 500' });
      respondWith = 200;

      const del = await as(ctx, client).get(`/api/webhooks/${res.body.id}/deliveries`);
      expect(del.status).toBe(200);
      expect(del.body.total).toBe(2);
      expect(del.body.items[0]).toMatchObject({ status_code: 500, attempt: 1, org_id: client.orgId });

      const rot = await as(ctx, client).patch(`/api/webhooks/${res.body.id}`, { rotate_secret: true, max_retries: 3 });
      expect(rot.body.secret).toMatch(/^whsec_/);
      expect(rot.body.secret).not.toBe(secret);
      expect(rot.body.max_retries).toBe(3);
      expect((await as(ctx, client).post('/api/webhooks', { url: 'ftp://x.example.com' })).status).toBe(400);
      expect((await as(ctx, client).post('/api/webhooks', { url, events: ['nope'] })).status).toBe(400);
      expect((await as(ctx, client).delete(`/api/webhooks/${res.body.id}`)).status).toBe(200);
      const audits = await ctx.db.selectFrom('audit_logs').select(['before', 'after']).where('entity_id', '=', res.body.id).execute();
      expect(JSON.stringify(audits)).not.toMatch(/whsec_|v1:/);
    });

    it('reports connection errors', async () => {
      const res = await as(ctx, client).post('/api/webhooks', { url: 'http://127.0.0.1:9/never' });
      const t = await as(ctx, client).post(`/api/webhooks/${res.body.id}/test`);
      expect(t.body.ok).toBe(false);
      expect(t.body.status_code).toBeNull();
      expect(t.body.error).toBeTruthy();
    });
  });

  describe('blocklist', () => {
    it('numbers: admin global, reseller-wide, client own; normalizes; validates', async () => {
      const g = await as(ctx, admin).post('/api/blocklist/numbers', { prefix: '+44 7700-900' });
      expect(g.status).toBe(201);
      expect(g.body).toMatchObject({ org_id: null, prefix: '447700900' });
      expect((await as(ctx, admin).get('/api/blocklist/numbers')).body.items.map((x: { id: string }) => x.id)).toContain(g.body.id);
      const r = await as(ctx, reseller).post('/api/blocklist/numbers', { prefix: '1900' });
      expect(r.body.org_id).toBe(reseller.orgId);
      expect((await as(ctx, client).post('/api/blocklist/numbers', { prefix: 'abc' })).status).toBe(400);
      expect((await as(ctx, client).delete(`/api/blocklist/numbers/${g.body.id}`)).status).toBe(403);
      // the reseller's row applies to the client but is not visible to it (RLS) -> 404
      expect((await as(ctx, client).delete(`/api/blocklist/numbers/${r.body.id}`)).status).toBe(404);
      expect((await as(ctx, admin).delete(`/api/blocklist/numbers/${g.body.id}`)).status).toBe(200);
      await waitFor(() => ctx.invalidations.some((m) => m.entity === 'blocked_numbers' && m.id === g.body.id));
    });

    it('keywords: only an RE2-safe subset is accepted', async () => {
      for (const p of ['(?=foo)bar', '(?!x)y', '(?<=a)b', '(?<!a)b', '(a)\\1', '(?<n>a)\\k<n>', 'a++', '(?>a)', '[a-']) {
        const res = await as(ctx, client).post('/api/blocklist/keywords', { pattern: p });
        expect([p, res.status]).toEqual([p, 400]);
      }
      for (const p of ['casino', '\\bfree\\s+money\\b', '(?i)win(ner)?', '(?P<word>lottery)', '[0-9]{4,}']) {
        const res = await as(ctx, client).post('/api/blocklist/keywords', { pattern: p });
        expect([p, res.status]).toEqual([p, 201]);
      }
      expect((await as(ctx, client).get('/api/blocklist/keywords?q=casino')).body.total).toBe(1);
    });
  });

  describe('notification settings', () => {
    it('get defaults, put (upsert), validation, audited', async () => {
      const g = await as(ctx, client).get('/api/notifications/settings');
      expect(g.body).toMatchObject({ org_id: client.orgId, email_enabled: true, low_balance: true });
      const p = await as(ctx, client).put('/api/notifications/settings', { email_to: ['Ops@Example.com'], telegram_enabled: true, telegram_chat_id: '-1001234' });
      expect(p.status).toBe(200);
      expect(p.body).toMatchObject({ email_to: ['ops@example.com'], telegram_enabled: true, telegram_chat_id: '-1001234' });
      expect((await as(ctx, client).put('/api/notifications/settings', { telegram_chat_id: null })).status).toBe(400);
      expect((await as(ctx, client).put('/api/notifications/settings', { email_to: ['nope'] })).status).toBe(400);
      expect((await as(ctx, reseller).get(`/api/notifications/settings?org_id=${client.orgId}`)).body.telegram_enabled).toBe(true);
      const audit = await ctx.db.selectFrom('audit_logs').select('id').where('action', '=', 'notifications.update').where('target_org_id', '=', client.orgId).execute();
      expect(audit).toHaveLength(1);
    });
  });

  describe('templates', () => {
    let routeId: string;
    beforeAll(async () => {
      routeId = (await as(ctx, admin).post('/api/routes', { name: uniq('tpl-route'), template_mode: true })).body.id;
      await as(ctx, admin).put(`/api/orgs/${reseller.orgId}/routes`, [{ route_id: routeId, prefix: '', rate_micros: 1000 }]).expect(200);
      await as(ctx, reseller).put(`/api/orgs/${client.orgId}/routes`, [{ route_id: routeId, prefix: '', rate_micros: 2000 }]).expect(200);
    });

    it('admin: route-wide; reseller: per-client override; client: read-only effective', async () => {
      const wide = await as(ctx, admin).post('/api/templates', { route_id: routeId, name: 'default', template_body: 'Your code is {otp}. -{brand}' });
      expect(wide.status).toBe(201);
      expect(wide.body.org_id).toBeNull();
      expect(wide.body.extract_patterns.length).toBeGreaterThanOrEqual(1); // DB default (migration 005)
      expect((await as(ctx, admin).post('/api/templates', { route_id: routeId, name: 'dup', template_body: 'Code {otp}' })).status).toBe(409);
      expect((await as(ctx, admin).post('/api/templates', { route_id: routeId, org_id: client.orgId, name: 'x', template_body: 'Code {otp}' })).status).toBe(403);
      expect((await as(ctx, reseller).post('/api/templates', { route_id: routeId, name: 'x', template_body: 'Code {otp}' })).status).toBe(403);
      expect((await as(ctx, admin).post('/api/templates', { route_id: routeId, name: 'x', template_body: 'no placeholder' })).status).toBe(400);
      expect((await as(ctx, admin).post('/api/templates', { route_id: routeId, name: 'x', template_body: 'C {otp}', extract_patterns: ['(?=\\d)'] })).status).toBe(400);
      expect((await as(ctx, admin).post('/api/templates', { route_id: routeId, name: 'x', template_body: 'C {otp}', fallback_action: 'SEND_DEFAULT_TEMPLATE', is_active: false })).status).toBe(400);

      const clientEffective1 = await as(ctx, client).get('/api/templates');
      expect(clientEffective1.body.items.map((t: { id: string }) => t.id)).toEqual([wide.body.id]);

      const ov = await as(ctx, reseller).post('/api/templates', { route_id: routeId, org_id: client.orgId, name: 'client override', template_body: '{otp} is your login code', extract_patterns: ['\\b[0-9]{6}\\b'] });
      expect(ov.status).toBe(201);
      const eff = await as(ctx, client).get('/api/templates');
      expect(eff.body.items.map((t: { id: string }) => t.id)).toEqual([ov.body.id]);
      expect((await as(ctx, client).post('/api/templates', { route_id: routeId, org_id: client.orgId, name: 'x', template_body: '{otp}' })).status).toBe(403);
      expect((await as(ctx, client).patch(`/api/templates/${ov.body.id}`, { name: 'mine' })).status).toBe(403);
      expect((await as(ctx, reseller).patch(`/api/templates/${wide.body.id}`, { name: 'hijack' })).status).toBe(403);
      expect((await as(ctx, admin).patch(`/api/templates/${ov.body.id}`, { name: 'admin edit' })).status).toBe(403);
      const rl = await as(ctx, reseller).get(`/api/templates?route_id=${routeId}`);
      expect(rl.body.items.map((t: { id: string }) => t.id).sort()).toEqual([wide.body.id, ov.body.id].sort());

      const patched = await as(ctx, reseller).patch(`/api/templates/${ov.body.id}`, { brand: 'ClientCo' });
      expect(patched.body.brand).toBe('ClientCo');
      await waitFor(() => ctx.invalidations.some((m) => m.entity === 'route_templates' && m.id === ov.body.id));
      expect((await as(ctx, reseller).delete(`/api/templates/${ov.body.id}`)).status).toBe(200);
    });

    it('preview proxies the engine; clients preview their own effective template', async () => {
      const p = await as(ctx, client).post('/api/templates/preview', { text: 'Ur code 849201', route_id: routeId, org_id: reseller.orgId });
      expect(p.status).toBe(200);
      expect(p.body).toMatchObject({ otp: '849201', action: 'TEMPLATED', parts: 1 });
      expect(ctx.engine.calls('/internal/v1/template/preview')[0].body).toEqual({ text: 'Ur code 849201', route_id: routeId, org_id: client.orgId });
      const inline = await as(ctx, admin).post('/api/templates/preview', {
        text: 'code 1234',
        template: { extract_patterns: ['\\b[0-9]{4}\\b'], template_body: 'OTP {otp}' },
      });
      expect(inline.body.output).toBe('OTP 1234');
      expect((await as(ctx, admin).post('/api/templates/preview', { text: 'x' })).status).toBe(400);
      ctx.engine.down = true;
      const down = await as(ctx, admin).post('/api/templates/preview', { text: 'x', route_id: routeId });
      expect(down.status).toBe(502);
      expect(down.body.error_code).toBe('INTERNAL');
    });
  });

  describe('monitor & health', () => {
    it('admin sees all sessions; reseller its clients’; health is public', async () => {
      ctx.engine.sessions = [
        { session_id: 's1', org_id: client.orgId, system_id: 'a', bind_type: 'TRX', remote_addr: '1.2.3.4:5', bound_since: new Date().toISOString(), tps_current: 0, submitted_total: 0 },
        { session_id: 's2', org_id: '00000000-0000-4000-8000-000000000001', system_id: 'b', bind_type: 'TX', remote_addr: '1.2.3.4:6', bound_since: new Date().toISOString(), tps_current: 0, submitted_total: 0 },
      ];
      expect((await as(ctx, admin).get('/api/monitor/smpp-sessions')).body.sessions).toHaveLength(2);
      const rs = await as(ctx, reseller).get('/api/monitor/smpp-sessions');
      expect(rs.body.sessions.map((s: { session_id: string }) => s.session_id)).toEqual(['s1']);
      expect((await as(ctx, reseller).get('/api/monitor/connections')).status).toBe(403);
      expect((await as(ctx, admin).get('/api/monitor/connections')).body).toEqual({ connections: [] });
      const h = await ctx.http().get('/api/health');
      expect(h.status).toBe(200);
      expect(h.body).toEqual({ ok: true, db: true, redis: true, engine: true });
    });

    it('unknown routes return NOT_FOUND in the contract error shape', async () => {
      const r = await as(ctx, admin).get('/api/does-not-exist');
      expect(r.status).toBe(404);
      expect(r.body.error_code).toBe('NOT_FOUND');
      const bad = await as(ctx, admin).get('/api/orgs/not-a-uuid');
      expect(bad.status).toBe(404);
      const malformed = await ctx.http().post('/api/auth/login').set('Content-Type', 'application/json').send('{"email":');
      expect(malformed.status).toBe(400);
      expect(malformed.body.error_code).toBe('INVALID_REQUEST');
    });
  });
});
