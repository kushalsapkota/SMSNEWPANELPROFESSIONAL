import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { assertWebhookTarget, isBlockedAddress } from '../src/webhooks/egress';
import { Session, TestCtx, adminLogin, as, createChild, setup, uniq } from './helpers';

describe('webhook SSRF guard', () => {
  describe('address classification', () => {
    it.each([
      '127.0.0.1', '127.255.0.9', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
      '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '::1', '::', 'fe80::1', 'fd00::1', 'fc12::1', 'ff02::1',
      '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '2002:a00:1::1', '::127.0.0.1', 'not-an-ip',
    ])('%s is blocked', (ip) => expect(isBlockedAddress(ip)).toBe(true));

    it.each(['8.8.8.8', '1.1.1.1', '93.184.215.14', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808'])(
      '%s is public',
      (ip) => expect(isBlockedAddress(ip)).toBe(false),
    );

    it('save-time validation rejects private targets (literal or resolved) and credentials', async () => {
      const policy = { allowPrivate: false };
      for (const url of ['http://127.0.0.1:3200/api/health', 'http://[::1]/x', 'http://localhost:9100/metrics', 'http://169.254.169.254/latest/meta-data', 'http://0x7f.1/']) {
        await expect(assertWebhookTarget(url, policy)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      }
      await expect(assertWebhookTarget('https://user:pw@93.184.215.14/x', policy)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      await expect(assertWebhookTarget('https://93.184.215.14/hook', policy)).resolves.toBeUndefined();
      await expect(assertWebhookTarget('http://127.0.0.1/x', { allowPrivate: true })).resolves.toBeUndefined();
    });
  });

  describe('api (WEBHOOK_ALLOW_PRIVATE_TARGETS off)', () => {
    let ctx: TestCtx;
    let client: Session;
    let server: http.Server;
    let port = 0;
    let hits = 0;

    beforeAll(async () => {
      server = http.createServer((_req, res) => {
        hits += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"internal":"secret-metrics"}');
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      port = (server.address() as AddressInfo).port;
      ctx = await setup({ env: () => ({ WEBHOOK_ALLOW_PRIVATE_TARGETS: '0' }) });
      const admin = await adminLogin(ctx);
      const reseller = await createChild(ctx, admin, uniq('ssrf-r'));
      client = await createChild(ctx, reseller, uniq('ssrf-c'));
    });
    afterAll(async () => {
      await ctx.close();
      await new Promise<void>((r) => server.close(() => r()));
    });

    it('refuses to save internal URLs (create and update)', async () => {
      for (const url of [`http://127.0.0.1:${port}/x`, `http://localhost:${port}/x`, 'http://10.0.0.5/hook', 'http://169.254.169.254/latest', 'http://[::1]:9100/metrics']) {
        const r = await as(ctx, client).post('/api/webhooks', { url });
        expect(r.status).toBe(400);
        expect(r.body.details.field).toBe('url');
      }
      const ok = await as(ctx, client).post('/api/webhooks', { url: 'https://93.184.215.14/hook' });
      expect(ok.status).toBe(201);
      const upd = await as(ctx, client).patch(`/api/webhooks/${ok.body.id}`, { url: `http://127.0.0.1:${port}/x` });
      expect(upd.status).toBe(400);
    });

    it('test endpoint re-checks at connect time (stored / rebound targets) and never returns the body', async () => {
      // Rows that became internal after validation (DNS rebinding, or saved before this fix).
      for (const url of [`http://127.0.0.1:${port}/api/health`, `http://localhost:${port}/api/health`]) {
        const created = await as(ctx, client).post('/api/webhooks', { url: 'https://93.184.215.14/hook' }).expect(201);
        await ctx.db.updateTable('webhooks').set({ url }).where('id', '=', created.body.id).execute();
        const t = await as(ctx, client).post(`/api/webhooks/${created.body.id}/test`);
        expect(t.status).toBe(200);
        expect(t.body).toMatchObject({ ok: false, status_code: null, response_body: null });
        expect(t.body.error).toMatch(/not allowed|public/i);
        expect(JSON.stringify(t.body)).not.toContain('secret-metrics');
        const d = await ctx.db.selectFrom('webhook_deliveries').select(['status_code', 'error']).where('webhook_id', '=', created.body.id).executeTakeFirstOrThrow();
        expect(d.status_code).toBeNull();
      }
      expect(hits).toBe(0);
    });
  });
});
