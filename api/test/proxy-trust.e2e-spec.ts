import { Session, TestCtx, adminLogin, as, createApiKey, createChild, setup, uniq } from './helpers';

/**
 * X-Forwarded-For handling with TRUST_PROXY=1 (deploy finding: IP whitelists could be bypassed by
 * prepending a whitelisted address, e.g. `X-Forwarded-For: 127.0.0.1, 8.8.8.8`).
 * supertest connects from 127.0.0.1, i.e. the test client plays "the proxy" when loopback is trusted.
 */
describe('client IP behind proxies (TRUST_PROXY=1)', () => {
  const OFFICE = '203.0.113.7';

  describe('peer is a trusted proxy (default TRUSTED_PROXIES: loopback + private)', () => {
    let ctx: TestCtx;
    let client: Session & { email: string; password: string };
    let key: string;

    beforeAll(async () => {
      ctx = await setup({ env: () => ({ TRUST_PROXY: '1', TRUSTED_PROXIES: '' }) });
      const admin = await adminLogin(ctx);
      const reseller = await createChild(ctx, admin, uniq('xff-r'));
      client = await createChild(ctx, reseller, uniq('xff-c'));
      key = (await createApiKey(ctx, client)).key;
      // Self-lockout guard sees the XFF-derived IP, so add the PANEL rule "from the office".
      const panel = await as(ctx, client).post('/api/ip-whitelist', { cidr: OFFICE, scope: 'PANEL' }).set('X-Forwarded-For', OFFICE);
      expect(panel.status).toBe(201);
      expect((await as(ctx, client).post('/api/ip-whitelist', { cidr: OFFICE, scope: 'API' }).set('X-Forwarded-For', OFFICE)).status).toBe(201);
    });
    afterAll(async () => {
      await ctx.close();
    });

    const loginWith = (xff?: string) => {
      const r = ctx.http().post('/api/auth/login');
      if (xff !== undefined) r.set('X-Forwarded-For', xff);
      return r.send({ email: client.email, password: client.password });
    };
    const balanceWith = (xff?: string) => {
      const r = ctx.http().get('/v1/balance').set('Authorization', `Bearer ${key}`);
      if (xff !== undefined) r.set('X-Forwarded-For', xff);
      return r;
    };

    it('PANEL whitelist: the right-most untrusted hop is the client, spoofed left hops are ignored', async () => {
      expect((await loginWith(OFFICE)).status).toBe(200);
      // nginx -> web -> api appends trusted private/loopback hops: still the office
      expect((await loginWith(`${OFFICE}, 127.0.0.1`)).status).toBe(200);
      expect((await loginWith(`${OFFICE}, 172.18.0.1, 10.0.0.5`)).status).toBe(200);

      const other = await loginWith('8.8.8.8');
      expect(other.status).toBe(403);
      expect(other.body.error_code).toBe('IP_NOT_ALLOWED');
      // the reported bypass: attacker 8.8.8.8 prepends the whitelisted address
      const spoof = await loginWith(`${OFFICE}, 8.8.8.8`);
      expect(spoof.status).toBe(403);
      expect(spoof.body.error_code).toBe('IP_NOT_ALLOWED');
      // garbage to the right of a real hop cannot be used to fall back to the left one
      expect((await loginWith(`${OFFICE}, not-an-ip`)).status).toBe(403);
      // no header: the peer itself (127.0.0.1) is not whitelisted
      expect((await loginWith()).status).toBe(403);
    });

    it('API whitelist (ApiKeyGuard) uses the same rule', async () => {
      expect((await balanceWith(OFFICE)).status).toBe(200);
      const spoof = await balanceWith(`${OFFICE}, 8.8.8.8`);
      expect(spoof.status).toBe(403);
      expect(spoof.body.error_code).toBe('IP_NOT_ALLOWED');
      expect((await balanceWith('8.8.8.8')).status).toBe(403);
    });
  });

  describe('peer is NOT a trusted proxy (TRUSTED_PROXIES excludes loopback)', () => {
    let ctx: TestCtx;
    let client: Session & { email: string; password: string };
    let key: string;

    beforeAll(async () => {
      ctx = await setup({ env: () => ({ TRUST_PROXY: '1', TRUSTED_PROXIES: '10.0.0.0/8, 192.0.2.10' }) });
      const admin = await adminLogin(ctx);
      const reseller = await createChild(ctx, admin, uniq('xff-r2'));
      client = await createChild(ctx, reseller, uniq('xff-c2'));
      key = (await createApiKey(ctx, client)).key;
      expect((await as(ctx, client).post('/api/ip-whitelist', { cidr: '127.0.0.1', scope: 'PANEL' })).status).toBe(201);
      expect((await as(ctx, client).post('/api/ip-whitelist', { cidr: OFFICE, scope: 'API' })).status).toBe(201);
    });
    afterAll(async () => {
      await ctx.close();
    });

    it('X-Forwarded-For from a direct client is ignored entirely', async () => {
      const login = await ctx.http().post('/api/auth/login').set('X-Forwarded-For', '8.8.8.8').send({ email: client.email, password: client.password });
      expect(login.status).toBe(200);
      const spoof = await ctx.http().get('/v1/balance').set('Authorization', `Bearer ${key}`).set('X-Forwarded-For', OFFICE);
      expect(spoof.status).toBe(403);
      expect(spoof.body.error_code).toBe('IP_NOT_ALLOWED');
    });
  });
});
